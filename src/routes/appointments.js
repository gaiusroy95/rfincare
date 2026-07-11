import { Router } from 'express';
import { z } from 'zod';
import { getPool } from '../db/pool.js';
import { newId } from '../lib/ids.js';
import { sendEmail } from '../lib/email.js';
import { getSiteContactSettings } from '../lib/siteContactSettings.js';
import { buildIcsInvite } from '../lib/ics.js';
import { createGoogleCalendarEvent, googleCalendarConfigured } from '../lib/googleCalendar.js';

export const appointmentsRouter = Router();

let schemaReady = false;

async function ensureAppointmentsSchema() {
  if (schemaReady) return;
  const pool = getPool();
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS expert_appointments (
      id VARCHAR(36) PRIMARY KEY,
      full_name VARCHAR(200) NOT NULL,
      email VARCHAR(255) NOT NULL,
      phone VARCHAR(20) NOT NULL,
      topic VARCHAR(120) NOT NULL,
      preferred_date DATE NOT NULL,
      preferred_time VARCHAR(16) NOT NULL,
      duration_minutes INT NOT NULL DEFAULT 30,
      notes TEXT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'scheduled',
      google_event_id VARCHAR(255) NULL,
      google_event_link TEXT NULL,
      starts_at TIMESTAMPTZ NOT NULL,
      ends_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  schemaReady = true;
}

const BookSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(255),
  phone: z.string().trim().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number'),
  topic: z.string().trim().min(2).max(120),
  preferredDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  preferredTime: z.string().regex(/^\d{2}:\d{2}$/),
  notes: z.string().trim().max(1000).optional().nullable(),
});

function salesTeamEmail(contact) {
  return (
    process.env.SALES_TEAM_EMAIL
    || process.env.APPOINTMENT_SALES_EMAIL
    || contact?.emails?.[0]
    || contact?.email
    || 'support@rfincare.com'
  );
}

function combineDateTimeIst(dateStr, timeStr) {
  // Interpret slot as Asia/Kolkata local time
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  // Build as UTC offset +05:30
  const utcMs = Date.UTC(y, m - 1, d, hh - 5, mm - 30, 0);
  return new Date(utcMs);
}

function formatDisplay(date) {
  return date.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

appointmentsRouter.get('/slots', async (_req, res, next) => {
  try {
    const slots = [];
    const now = new Date();
    const hours = ['09:00', '10:00', '11:00', '12:00', '14:00', '15:00', '16:00', '17:00'];

    for (let dayOffset = 0; dayOffset < 14; dayOffset += 1) {
      const day = new Date(now);
      day.setDate(day.getDate() + dayOffset);
      // Skip Sundays (0)
      if (day.getDay() === 0) continue;

      const y = day.getFullYear();
      const m = String(day.getMonth() + 1).padStart(2, '0');
      const d = String(day.getDate()).padStart(2, '0');
      const date = `${y}-${m}-${d}`;

      for (const time of hours) {
        const starts = combineDateTimeIst(date, time);
        if (starts.getTime() < Date.now() + 60 * 60 * 1000) continue;
        slots.push({ date, time, label: `${formatDisplay(starts)}` });
      }
    }

    res.json({ slots: slots.slice(0, 56) });
  } catch (err) {
    next(err);
  }
});

appointmentsRouter.post('/', async (req, res, next) => {
  try {
    await ensureAppointmentsSchema();
    const input = BookSchema.parse(req.body);
    const durationMinutes = 30;
    const startsAt = combineDateTimeIst(input.preferredDate, input.preferredTime);
    if (Number.isNaN(startsAt.getTime()) || startsAt.getTime() < Date.now()) {
      return res.status(400).json({ error: 'Please choose a future date and time slot.' });
    }
    const endsAt = new Date(startsAt.getTime() + durationMinutes * 60 * 1000);

    const contact = await getSiteContactSettings();
    const salesEmail = salesTeamEmail(contact);
    const id = newId();

    const topicLabel = input.topic;
    const summary = `Rfincare Expert Call — ${input.fullName}`;
    const description = [
      `Customer: ${input.fullName}`,
      `Email: ${input.email}`,
      `Phone: +91-${input.phone}`,
      `Topic: ${topicLabel}`,
      input.notes ? `Notes: ${input.notes}` : null,
      '',
      'Booked via Rfincare Talk to Expert.',
    ]
      .filter(Boolean)
      .join('\n');

    let google = { created: false };
    try {
      google = await createGoogleCalendarEvent({
        summary,
        description,
        startIso: startsAt.toISOString(),
        endIso: endsAt.toISOString(),
        attendeeEmails: [input.email, salesEmail],
        location: 'Rfincare — Phone / Video consultation',
      });
    } catch (err) {
      console.warn('[appointments] Google Calendar sync failed:', err?.message || err);
      google = { created: false, reason: err?.message || 'calendar_error' };
    }

    const pool = getPool();
    await pool.execute(
      `INSERT INTO expert_appointments (
         id, full_name, email, phone, topic, preferred_date, preferred_time,
         duration_minutes, notes, status, google_event_id, google_event_link,
         starts_at, ends_at
       ) VALUES (
         :id, :full_name, :email, :phone, :topic, :preferred_date, :preferred_time,
         :duration_minutes, :notes, 'scheduled', :google_event_id, :google_event_link,
         :starts_at, :ends_at
       )`,
      {
        id,
        full_name: input.fullName,
        email: input.email,
        phone: input.phone,
        topic: topicLabel,
        preferred_date: input.preferredDate,
        preferred_time: input.preferredTime,
        duration_minutes: durationMinutes,
        notes: input.notes || null,
        google_event_id: google.eventId || null,
        google_event_link: google.htmlLink || null,
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
      },
    );

    const whenLabel = formatDisplay(startsAt);
    const ics = buildIcsInvite({
      uid: `${id}@rfincare.com`,
      summary,
      description,
      location: 'Rfincare — Phone / Video consultation',
      start: startsAt,
      end: endsAt,
      organizerEmail: salesEmail,
      attendeeEmails: [input.email, salesEmail],
    });
    const icsAttachment = {
      filename: 'rfincare-appointment.ics',
      content: Buffer.from(ics, 'utf8'),
      contentType: 'text/calendar; charset=utf-8; method=REQUEST',
    };

    const customerSubject = `Appointment confirmed — ${whenLabel}`;
    const customerText = [
      `Hi ${input.fullName},`,
      '',
      'Your consultation with an Rfincare financial expert is confirmed.',
      '',
      `When: ${whenLabel} (IST)`,
      `Topic: ${topicLabel}`,
      `Duration: ${durationMinutes} minutes`,
      google.htmlLink ? `Calendar: ${google.htmlLink}` : null,
      '',
      'Our sales team will call you on +91-' + input.phone + ' at the scheduled time.',
      '',
      'Need to reschedule? Reply to this email or contact support@rfincare.com.',
      '',
      '— Team Rfincare',
    ]
      .filter(Boolean)
      .join('\n');

    const salesSubject = `New expert appointment — ${input.fullName} · ${whenLabel}`;
    const salesText = [
      'A customer booked a Talk to Expert appointment.',
      '',
      `Name: ${input.fullName}`,
      `Email: ${input.email}`,
      `Phone: +91-${input.phone}`,
      `When: ${whenLabel} (IST)`,
      `Topic: ${topicLabel}`,
      input.notes ? `Notes: ${input.notes}` : null,
      google.htmlLink ? `Google Calendar: ${google.htmlLink}` : null,
      google.created ? null : 'Note: Google Calendar sync was skipped or failed — use the ICS attachment.',
      '',
      `Appointment ID: ${id}`,
    ]
      .filter(Boolean)
      .join('\n');

    const [customerMail, salesMail] = await Promise.all([
      sendEmail({
        to: input.email,
        subject: customerSubject,
        text: customerText,
        html: `<pre style="font-family:sans-serif;white-space:pre-wrap">${customerText}</pre>`,
        attachments: [icsAttachment],
      }),
      sendEmail({
        to: salesEmail,
        subject: salesSubject,
        text: salesText,
        html: `<pre style="font-family:sans-serif;white-space:pre-wrap">${salesText}</pre>`,
        attachments: [icsAttachment],
      }),
    ]);

    res.status(201).json({
      id,
      status: 'scheduled',
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      whenLabel,
      googleCalendar: {
        configured: googleCalendarConfigured(),
        synced: Boolean(google.created),
        eventLink: google.htmlLink || null,
        reason: google.reason || null,
      },
      emails: {
        customer: customerMail,
        sales: salesMail,
        salesEmail,
      },
      message: 'Appointment booked. Confirmation emails sent to you and our sales team.',
    });
  } catch (err) {
    if (err?.name === 'ZodError') {
      return res.status(400).json({ error: err.errors?.[0]?.message || 'Invalid booking details' });
    }
    next(err);
  }
});
