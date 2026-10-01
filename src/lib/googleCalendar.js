/**
 * Create events on the company Google Calendar via a service account,
 * optionally with a Google Meet conference link.
 *
 * Env:
 *   GOOGLE_CALENDAR_CLIENT_EMAIL
 *   GOOGLE_CALENDAR_PRIVATE_KEY   (PEM; use \n for newlines)
 *   GOOGLE_CALENDAR_ID           (calendar id or "primary")
 *   APPOINTMENT_VIDEO_LINK       (optional static Meet/Jitsi room fallback)
 */

import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';

function privateKeyFromEnv() {
  const raw = process.env.GOOGLE_CALENDAR_PRIVATE_KEY || '';
  return String(raw).replace(/\\n/g, '\n').trim();
}

export function googleCalendarConfigured() {
  return Boolean(
    process.env.GOOGLE_CALENDAR_CLIENT_EMAIL
      && privateKeyFromEnv()
      && (process.env.GOOGLE_CALENDAR_ID || 'primary'),
  );
}

/** Prefer Google Meet from Calendar; else env static room; else unique Jitsi room. */
export function resolveAppointmentVideoLink({ appointmentId, hangoutLink = null } = {}) {
  const meet = String(hangoutLink || '').trim();
  if (/^https?:\/\//i.test(meet)) return { url: meet, provider: 'google_meet' };

  const configured = String(
    process.env.APPOINTMENT_VIDEO_LINK
      || process.env.GOOGLE_MEET_LINK
      || '',
  ).trim();
  if (/^https?:\/\//i.test(configured)) {
    return { url: configured, provider: 'configured' };
  }

  const room = String(appointmentId || randomBytes(6).toString('hex'))
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 24) || randomBytes(6).toString('hex');
  return {
    url: `https://meet.jit.si/Rfincare-${room}`,
    provider: 'jitsi',
  };
}

async function getAccessToken() {
  const clientEmail = process.env.GOOGLE_CALENDAR_CLIENT_EMAIL;
  const privateKey = privateKeyFromEnv();
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    {
      iss: clientEmail,
      scope: 'https://www.googleapis.com/auth/calendar',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    },
    privateKey,
    { algorithm: 'RS256' },
  );

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || 'Google token exchange failed');
  }
  return data.access_token;
}

/**
 * @param {{
 *   summary: string,
 *   description?: string,
 *   startIso: string,
 *   endIso: string,
 *   attendeeEmails?: string[],
 *   location?: string,
 *   createMeetLink?: boolean,
 *   requestId?: string,
 * }} event
 */
export async function createGoogleCalendarEvent(event) {
  if (!googleCalendarConfigured()) {
    return { created: false, reason: 'not_configured' };
  }

  const calendarId = encodeURIComponent(process.env.GOOGLE_CALENDAR_ID || 'primary');
  const token = await getAccessToken();
  const wantMeet = event.createMeetLink !== false;

  const attendees = (event.attendeeEmails || [])
    .filter(Boolean)
    .map((email) => ({ email }));

  const payload = {
    summary: event.summary,
    description: event.description || '',
    location: event.location || 'Rfincare — Online video consultation',
    start: { dateTime: event.startIso, timeZone: 'Asia/Kolkata' },
    end: { dateTime: event.endIso, timeZone: 'Asia/Kolkata' },
    attendees,
    guestsCanJoinMeet: true,
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'email', minutes: 60 },
        { method: 'popup', minutes: 15 },
      ],
    },
  };

  if (wantMeet) {
    payload.conferenceData = {
      createRequest: {
        requestId: String(event.requestId || `rf-${Date.now()}-${randomBytes(4).toString('hex')}`),
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    };
  }

  const query = new URLSearchParams({ sendUpdates: 'all' });
  if (wantMeet) query.set('conferenceDataVersion', '1');

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?${query}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
  );
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || 'Google Calendar event create failed');
  }

  const hangoutLink =
    data.hangoutLink
    || data.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri
    || null;

  return {
    created: true,
    eventId: data.id,
    htmlLink: data.htmlLink,
    hangoutLink,
    meetLink: hangoutLink,
  };
}
