import { ZodError } from 'zod';

export function errorMiddleware(err, _req, res, _next) {
  let status = Number(err?.status || 500);
  let message = err?.message || 'Internal server error';

  if (err instanceof ZodError) {
    status = 400;
    message = err.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
  } else if (err?.code === 'LIMIT_FILE_SIZE') {
    status = 413;
    message = 'File is too large';
  } else if (err?.name === 'MulterError') {
    status = 400;
    message = err.message || 'Invalid file upload';
  }

  if (status >= 500) {
    // eslint-disable-next-line no-console
    console.error(err);
  }

  res.status(status).json({ error: message });
}

