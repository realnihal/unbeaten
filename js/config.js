// Leaderboard API base URL. Set the production value to the deployed Worker URL
// (e.g. https://unbeaten-api.<account>.workers.dev). When it's null, the game still works
// fully offline; runs just aren't ranked and the leaderboard shows as unavailable.
const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
const PRODUCTION_API = null;

export const API_BASE = LOCAL ? 'http://localhost:8787' : PRODUCTION_API;
