// Leaderboard API base URL. When it's null, the game still works fully offline;
// runs just aren't ranked and the leaderboard shows as unavailable.
const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
const PRODUCTION_API = 'https://api.unbeatenxi.tech';

export const API_BASE = LOCAL ? 'http://localhost:8787' : PRODUCTION_API;
