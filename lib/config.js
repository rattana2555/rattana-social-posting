export const VERSION = '1.0';
export const PORT = Number(process.env.PORT) || 3210;
// Second server that only serves uploaded media files; this is the port exposed through the tunnel
export const MEDIA_PORT = Number(process.env.MEDIA_PORT) || 3211;
export const BASE_URL = `http://localhost:${PORT}`;
