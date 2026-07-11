/**
 * Create events on the company Google Calendar via a service account.
 *
 * Env:
 *   GOOGLE_CALENDAR_CLIENT_EMAIL
 *   GOOGLE_CALENDAR_PRIVATE_KEY   (PEM; use \n for newlines)
 *   GOOGLE_CALENDAR_ID           (calendar id or "primary")
 */

import jwt from 'jsonwebtoken';

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
 * }} event
 */
export async function createGoogleCalendarEvent(event) {
  if (!googleCalendarConfigured()) {
    return { created: false, reason: 'not_configured' };
  }

  const calendarId = encodeURIComponent(process.env.GOOGLE_CALENDAR_ID || 'primary');
  const token = await getAccessToken();

  const attendees = (event.attendeeEmails || [])
    .filter(Boolean)
    .map((email) => ({ email }));

  const payload = {
    summary: event.summary,
    description: event.description || '',
    location: event.location || 'Rfincare — Online / Phone consultation',
    start: { dateTime: event.startIso, timeZone: 'Asia/Kolkata' },
    end: { dateTime: event.endIso, timeZone: 'Asia/Kolkata' },
    attendees,
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'email', minutes: 60 },
        { method: 'popup', minutes: 15 },
      ],
    },
  };

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?sendUpdates=all`,
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

  return {
    created: true,
    eventId: data.id,
    htmlLink: data.htmlLink,
    hangoutLink: data.hangoutLink || null,
  };
}
