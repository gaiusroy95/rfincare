function extractYoutubeId(url) {
  if (!url) return null;
  const value = String(url).trim();
  if (!value) return null;
  const patterns = [
    /(?:youtu\.be\/|youtube\.com\/(?:embed\/|shorts\/|live\/|v\/))([\w-]{11})/i,
    /[?&]v=([\w-]{11})/i,
    /vid:([\w-]{11})/i,
    /\/vi\/([\w-]{11})(?:\/|$)/i
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) return match[1];
  }
  return null;
}
function normalizeYoutubeWatchUrl(url) {
  const id = extractYoutubeId(url);
  return id ? `https://www.youtube.com/watch?v=${id}` : null;
}
export {
  extractYoutubeId,
  normalizeYoutubeWatchUrl
};
