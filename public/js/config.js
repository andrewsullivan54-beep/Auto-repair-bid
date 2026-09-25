/* Auto Repair Bids — environment config. Loaded BEFORE js/common.js on every page.
 *
 * Local web dev: API_BASE stays "" so `npm start` + http://localhost:3000
 * keeps working untouched (same-origin fetch, no changes needed on Windows).
 *
 * Native phone app (Capacitor iOS/Android): the webview runs on
 * capacitor://localhost, so API calls can't be same-origin — they go to the
 * hosted API URL in NATIVE_API_BASE instead. That URL is a PLACEHOLDER until
 * Andrew picks real backend hosting; change it in this one spot.
 *
 * To force a base URL explicitly (any environment):
 *   window.APP_CONFIG = { API_BASE: 'https://my-api.example.com' };
 */
'use strict';
window.APP_CONFIG = window.APP_CONFIG || {};
if (!window.APP_CONFIG.API_BASE) {
  window.APP_CONFIG.API_BASE = '';
}
// Placeholder hosted API for native builds — real backend host is TBD.
window.NATIVE_API_BASE = 'https://api.autorepairbids.com';
