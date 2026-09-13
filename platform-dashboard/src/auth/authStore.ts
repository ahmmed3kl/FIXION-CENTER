import type { AuthSession } from "../types";
const SESSION_KEY="fixion.platform.session";
export function getSession():AuthSession|null { try { const raw=localStorage.getItem(SESSION_KEY); return raw?JSON.parse(raw) as AuthSession:null; } catch { return null; } }
export function setSession(session:AuthSession):void { localStorage.setItem(SESSION_KEY,JSON.stringify(session)); localStorage.setItem("fixion.platform.accessToken",session.accessToken); }
export function clearSession():void { localStorage.removeItem(SESSION_KEY); localStorage.removeItem("fixion.platform.accessToken"); }
