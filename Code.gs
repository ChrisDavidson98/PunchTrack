/**
 * WALKTHROUGH ITEMS TRACKER — Apps Script backend
 * ================================================
 * Mirrors the Scope Deviation backend's pattern:
 *  - GET  requests => read actions   (listJobs, getJob, listPriebItems)
 *  - POST requests => write/AI actions (createJob, saveJob, deleteJob, parseDictation)
 *  - CORS: POST bodies must stay text/plain (avoids preflight); response always JSON.
 *
 * SETUP
 * -----
 * 1. Create a new Google Sheet. Note its ID (from the URL).
 * 2. Extensions > Apps Script. Paste this file in as Code.gs.
 * 3. Project Settings > Script Properties, add:
 *      SHEET_ID     = <your sheet id>
 *      APP_TOKEN    = <any random string you invent>
 *      CLAUDE_API_KEY = <your Anthropic API key>
 * 4. Deploy > New deployment > Web app.
 *      Execute as: Me
 *      Who has access: Anyone
 *    Copy the /exec URL into the frontend's APPS_SCRIPT_URL constant.
 * 5. First run of any function will prompt for authorization — approve it.
 *
 * SHEET SCHEMA (tab name: "Jobs" holds one row per house/job;
 * tab name: "Items" holds one row per walkthrough item)
 * -----------------------------------------------------
 * Jobs:  slug | address | closingDate | createdAt | lastUpdated | archived
 * Items: id | slug | room | item | assignee | status | dateLogged | dateSent | notes | dateCompleted
 *   status ∈ "assignable" | "flagged" | "self_assigned" | "sent" | "completed"
 *   (an assignable item becomes "sent" once its report ships; flagged/self_assigned
 *    items are tracked but never auto-transition to "sent" via report-shipping —
 *    self_assigned items get marked sent when Chris ships/acknowledges his own list;
 *    flagged items only leave "flagged" when manually resolved in the UI)
 *   archived: "" while the house is active, an ISO timestamp once archived. An
 *   archived house drops off the active list and out of helper lists — its rows are
 *   never deleted.
 */

const PROPS = PropertiesService.getScriptProperties();
const SHEET_ID = PROPS.getProperty('SHEET_ID');
const APP_TOKEN = PROPS.getProperty('APP_TOKEN');
const CLAUDE_API_KEY = PROPS.getProperty('CLAUDE_API_KEY');
const CLAUDE_MODEL = 'claude-sonnet-4-5-20250929'; // update if you want a different model

const JOBS_SHEET = 'Jobs';
const ITEMS_SHEET = 'Items';

const JOBS_HEADERS = ['slug', 'address', 'closingDate', 'createdAt', 'lastUpdated', 'archived'];
const ITEMS_HEADERS = ['id', 'slug', 'room', 'item', 'assignee', 'status', 'dateLogged', 'dateSent', 'notes', 'dateCompleted'];

// ── The Prieb lane ───────────────────────────────────────────────
// Items assigned to Prieb are in-house work — they go to the helper, or to Chris
// himself when the helper can't get to one. There's nobody to email and no report to
// ship, so these never enter the assign => report => "mark as sent" flow the trades
// use. They run open => completed.
//
// The lane is keyed off the ASSIGNEE NAME, not off a dedicated status. That's
// deliberate: reassigning an item between a trade and Prieb is then a single field
// edit, and the item moves between lanes on its own — no separate "move" action to
// run, nothing that can fall out of sync with the assignee field.
//
// Aliases exist because the assignee arrives from voice dictation, where "Prieb
// Homes" and "in-house" mean the same lane as "Prieb" — folding them together here
// keeps a transcription wobble from stranding an item in a lane of its own.
const PRIEB_ALIASES = ['prieb', 'prieb homes', 'preib', 'in-house', 'in house', 'inhouse'];
const PRIEB_CANONICAL = 'Prieb';

function isPrieb(assignee) {
  return PRIEB_ALIASES.indexOf(String(assignee || '').trim().toLowerCase()) !== -1;
}

// ── Rate limiting ────────────────────────────────────────────────
// Same pattern as the Scope Deviation backend (BuildTrackUnified repo): CacheService
// buckets reset every RATE_LIMIT_WINDOW_SEC seconds. Reads are cheap and generous;
// writes are tighter since they mutate data; AI calls are strictest since each one
// costs real Anthropic API spend. There's also a separate PER-DAY ceiling on AI
// calls (stored in Script Properties, since CacheService can't hold a counter for
// a full day) so a leaked token left running overnight can't run up a large bill.
// Apps Script web apps don't expose caller IP/Origin, so these limits are global
// (shared across all callers), not per-caller — fine for a one-or-two-person tool.

const RATE_LIMIT_WINDOW_SEC = 60;
const RATE_LIMIT_MAX_READS = 60;   // listJobs / getJob / listPriebItems
const RATE_LIMIT_MAX_WRITES = 20;  // createJob / saveJob / deleteJob / archiveJob / addItems / shipReport / resolveFlag / updateItem
const RATE_LIMIT_MAX_AI = 10;      // parseDictation, per minute
const AI_DAILY_CAP = 150;          // parseDictation, per calendar day

function checkRateLimit(bucket, max) {
  const cache = CacheService.getScriptCache();
  const key = 'rl_' + bucket;
  const count = Number(cache.get(key) || 0);
  if (count >= max) {
    throw new Error('Rate limit exceeded — too many requests, try again in a minute.');
  }
  cache.put(key, String(count + 1), RATE_LIMIT_WINDOW_SEC);
}

function checkDailyAiCap() {
  const props = PropertiesService.getScriptProperties();
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const key = 'ai_count_' + today;
  const count = Number(props.getProperty(key) || 0);
  if (count >= AI_DAILY_CAP) {
    throw new Error('Daily AI request limit reached — resets tomorrow. If this wasn\'t you, rotate APP_TOKEN.');
  }
  props.setProperty(key, String(count + 1));
}

// ── Entry points ─────────────────────────────────────────────────

function doGet(e) {
  try {
    const params = e.parameter;
    checkToken(params.token);
    checkRateLimit('read', RATE_LIMIT_MAX_READS);
    const action = params.action;

    if (action === 'listJobs') return respond(listJobs());
    if (action === 'getJob') return respond(getJob(params.slug));
    if (action === 'listPriebItems') return respond(listPriebItems());

    return respond({ error: 'Unknown GET action: ' + action });
  } catch (err) {
    return respond({ error: err.message });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    checkToken(body.token);
    const action = body.action;

    // Every write runs inside withLock — see the note there for why.
    if (action === 'createJob') { checkRateLimit('write', RATE_LIMIT_MAX_WRITES); return respond(withLock(() => createJob(body.job))); }
    if (action === 'saveJob') { checkRateLimit('write', RATE_LIMIT_MAX_WRITES); return respond(withLock(() => saveJob(body.job))); }
    if (action === 'deleteJob') { checkRateLimit('write', RATE_LIMIT_MAX_WRITES); return respond(withLock(() => deleteJob(body.slug))); }
    if (action === 'archiveJob') { checkRateLimit('write', RATE_LIMIT_MAX_WRITES); return respond(withLock(() => archiveJob(body.slug, body.archived))); }
    if (action === 'addItems') { checkRateLimit('write', RATE_LIMIT_MAX_WRITES); return respond(withLock(() => addItems(body.slug, body.items))); }
    if (action === 'shipReport') { checkRateLimit('write', RATE_LIMIT_MAX_WRITES); return respond(withLock(() => shipReport(body.slug, body.assignee))); }
    if (action === 'resolveFlag') { checkRateLimit('write', RATE_LIMIT_MAX_WRITES); return respond(withLock(() => resolveFlag(body.itemId, body.resolution))); }
    if (action === 'updateItem') { checkRateLimit('write', RATE_LIMIT_MAX_WRITES); return respond(withLock(() => updateItem(body.item))); }
    if (action === 'parseDictation') {
      checkRateLimit('ai', RATE_LIMIT_MAX_AI);
      checkDailyAiCap();
      return respond(parseDictation(body.dictation));
    }

    return respond({ error: 'Unknown POST action: ' + action });
  } catch (err) {
    return respond({ error: err.message });
  }
}

function checkToken(token) {
  if (!APP_TOKEN || token !== APP_TOKEN) throw new Error('Invalid or missing token');
}

function respond(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ── Sheet helpers ────────────────────────────────────────────────

// Every write action holds this lock for its whole read-modify-write cycle.
//
// Without it there's a real race: each write reads the sheet, changes something in
// memory, then writes back. Tap COMPLETE on two items in quick succession and the
// second request can read the sheet *before* the first one has written — so the
// first change gets overwritten by a copy of the old data and silently vanishes.
// A phone on a slow connection in a basement makes that window wide.
function withLock(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    throw new Error('Busy — another change is still saving. Try again in a moment.');
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function getSheet(name, headers) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    return sh;
  }
  ensureHeaders(sh, headers);
  return sh;
}

// Adds any header column this code expects but the live sheet doesn't have yet,
// so a new column ships without anyone hand-editing the spreadsheet. Existing rows
// just get an empty cell there, which is exactly what "not archived" looks like.
function ensureHeaders(sh, headers) {
  const lastCol = sh.getLastColumn();
  if (!lastCol) { sh.appendRow(headers); return; }
  const existing = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  const missing = headers.filter(h => existing.indexOf(h) === -1);
  if (!missing.length) return;
  sh.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]);
}

function sheetToObjects(sh) {
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0];
  return values.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => (obj[h] = row[i]));
    return obj;
  }).filter(o => o[headers[0]] !== ''); // skip blank trailing rows
}

// Wipe-and-rewrite. Only for genuine bulk rewrites (deleting a whole job) — never
// for changing a field or two, which is what patchRows is for.
function objectsToSheet(sh, headers, objects) {
  sh.clear();
  sh.appendRow(headers);
  if (objects.length === 0) return;
  const rows = objects.map(o => headers.map(h => (o[h] !== undefined && o[h] !== null ? o[h] : '')));
  sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
}

// Targeted edit: find the rows matching `shouldPatch`, apply the fields `makePatch`
// returns, and write back ONLY the span of rows that actually changed.
//
// This replaces the old approach, where changing one cell meant clearing the entire
// sheet and rewriting every row. That was slow, and worse, it had a window where the
// sheet was genuinely empty — if the script died there (Apps Script timeout, a
// dropped connection) every item in the tool was gone with no way back. One cell
// should never put the whole sheet at risk.
//
// Reads the header row off the sheet rather than trusting the constant, so a column
// someone added by hand isn't clobbered.
function patchRows(sh, shouldPatch, makePatch) {
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return 0;
  const head = values[0];
  let firstChanged = -1, lastChanged = -1, changed = 0;

  for (let r = 1; r < values.length; r++) {
    const obj = {};
    head.forEach((h, i) => (obj[h] = values[r][i]));
    if (obj[head[0]] === '') continue; // blank trailing row
    if (!shouldPatch(obj)) continue;

    const patch = makePatch(obj);
    if (!patch) continue;
    const keys = Object.keys(patch);
    if (!keys.length) continue;

    keys.forEach(k => {
      const i = head.indexOf(k);
      if (i >= 0) values[r][i] = patch[k] === undefined || patch[k] === null ? '' : patch[k];
    });
    if (firstChanged === -1) firstChanged = r;
    lastChanged = r;
    changed++;
  }

  if (!changed) return 0;
  const block = values.slice(firstChanged, lastChanged + 1);
  sh.getRange(firstChanged + 1, 1, block.length, head.length).setValues(block);
  return changed;
}

// ── Jobs ─────────────────────────────────────────────────────────

// Sheets hands back a closingDate as either a plain "YYYY-MM-DD" string or its own
// Date type, depending on how the cell got written. Normalize both to "YYYY-MM-DD"
// so they sort as plain text.
//
// The Date branch is not optional. Server-side the cell really is a Date object —
// it only turns into an ISO string later, when the response is serialized to JSON.
// String(aDate) gives "Mon Sep 28 2026 …", so slicing the first 10 characters
// yields "Mon Sep 28", every house ends up with an empty key, and the whole list
// silently falls back to creation order. The frontend never sees this because by
// then it's a string.
function closingKey(job) {
  const v = job.closingDate;
  if (!v) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return isNaN(v.getTime()) ? '' : Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  const raw = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '';
}

// Sorted by closing date, soonest first — the house closing next is the highest
// priority, and that single rule is what orders the job list and every helper list
// the tool produces. Houses with no closing date yet sink to the bottom (newest
// first among themselves) rather than being treated as infinitely urgent.
function listJobs() {
  const sh = getSheet(JOBS_SHEET, JOBS_HEADERS);
  return sheetToObjects(sh).sort((a, b) => {
    const ka = closingKey(a), kb = closingKey(b);
    if (ka && kb) return ka < kb ? -1 : ka > kb ? 1 : 0;
    if (ka) return -1;
    if (kb) return 1;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });
}

function getJob(slug) {
  const jobsSh = getSheet(JOBS_SHEET, JOBS_HEADERS);
  const job = sheetToObjects(jobsSh).find(j => j.slug === slug);
  if (!job) throw new Error('Job not found: ' + slug);

  const itemsSh = getSheet(ITEMS_SHEET, ITEMS_HEADERS);
  const items = sheetToObjects(itemsSh).filter(it => it.slug === slug);

  return { ...job, items };
}

function createJob(job) {
  const sh = getSheet(JOBS_SHEET, JOBS_HEADERS);
  sh.appendRow(JOBS_HEADERS.map(h => job[h] || ''));
  return { ok: true };
}

function saveJob(job) {
  const sh = getSheet(JOBS_SHEET, JOBS_HEADERS);
  const jobs = sheetToObjects(sh);
  const idx = jobs.findIndex(j => j.slug === job.slug);
  const updated = { ...(idx >= 0 ? jobs[idx] : {}), ...job, lastUpdated: new Date().toISOString() };
  if (idx >= 0) jobs[idx] = updated;
  else jobs.push(updated);
  objectsToSheet(sh, JOBS_HEADERS, jobs);
  return { ok: true };
}

// Archive is NOT delete. It stamps the Jobs row so the house drops off the active
// list and out of helper lists, and that's all — every item row stays exactly where
// it is, forever. Pass archived=false to bring a house back.
function archiveJob(slug, archived) {
  const sh = getSheet(JOBS_SHEET, JOBS_HEADERS);
  const stamp = archived === false ? '' : new Date().toISOString();
  const n = patchRows(sh, j => j.slug === slug, () => ({ archived: stamp, lastUpdated: new Date().toISOString() }));
  if (!n) throw new Error('Job not found: ' + slug);
  return { ok: true, archived: stamp };
}

function deleteJob(slug) {
  const jobsSh = getSheet(JOBS_SHEET, JOBS_HEADERS);
  const jobs = sheetToObjects(jobsSh).filter(j => j.slug !== slug);
  objectsToSheet(jobsSh, JOBS_HEADERS, jobs);

  const itemsSh = getSheet(ITEMS_SHEET, ITEMS_HEADERS);
  const items = sheetToObjects(itemsSh).filter(it => it.slug !== slug);
  objectsToSheet(itemsSh, ITEMS_HEADERS, items);

  return { ok: true };
}

// ── Items ────────────────────────────────────────────────────────

// Appends newly dictated items. Only the new rows are written — the rest of the
// sheet is never touched, so saving a walkthrough can't disturb a house you weren't
// even looking at.
function addItems(slug, items) {
  if (!items || !items.length) return { ok: true, count: 0 };
  const sh = getSheet(ITEMS_SHEET, ITEMS_HEADERS);
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const rows = items.map(it => {
    const row = { ...it, slug };
    return head.map(h => (row[h] !== undefined && row[h] !== null ? row[h] : ''));
  });
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, head.length).setValues(rows);
  return { ok: true, count: rows.length };
}

function shipReport(slug, assignee) {
  const sh = getSheet(ITEMS_SHEET, ITEMS_HEADERS);
  const now = new Date().toISOString();
  const n = patchRows(
    sh,
    it => it.slug === slug && String(it.assignee).trim() === String(assignee).trim() && it.status === 'assignable',
    () => ({ status: 'sent', dateSent: now })
  );
  return { ok: true, count: n };
}

function resolveFlag(itemId, resolution) {
  // resolution: { newAssignee, newStatus } — reassign to "assignable" or close as "sent"/other
  const sh = getSheet(ITEMS_SHEET, ITEMS_HEADERS);
  const n = patchRows(sh, it => it.id === itemId, it => {
    const patch = {};
    if (resolution.newAssignee !== undefined) patch.assignee = resolution.newAssignee;
    if (resolution.newStatus) patch.status = resolution.newStatus;
    if (resolution.notes !== undefined) patch.notes = resolution.notes;
    return patch;
  });
  if (!n) throw new Error('Item not found: ' + itemId);
  return { ok: true };
}

// General single-item field editor — manual edits (room / item / assignee / notes),
// and tap-to-complete (pass { id, status: "completed", dateCompleted: <iso> }).
function updateItem(item) {
  const sh = getSheet(ITEMS_SHEET, ITEMS_HEADERS);
  const n = patchRows(sh, it => it.id === item.id, () => {
    const patch = { ...item };
    delete patch.id; // never rewrite the key we matched on
    return patch;
  });
  if (!n) throw new Error('Item not found: ' + item.id);
  return { ok: true };
}

// ── Prieb helper list ────────────────────────────────────────────
// One call returns every open in-house item across all active houses, already
// grouped by house and ordered by closing date. Doing the join and the sort here
// rather than in the app matters for a practical reason: the alternative is the
// phone calling getJob once per house, which at ~60 houses would trip this
// backend's own 60-reads-per-minute limit on a single screen load.
//
// Archived houses are excluded — that's the point of archiving.
function listPriebItems() {
  const jobs = sheetToObjects(getSheet(JOBS_SHEET, JOBS_HEADERS)).filter(j => !j.archived);
  const items = sheetToObjects(getSheet(ITEMS_SHEET, ITEMS_HEADERS))
    .filter(it => isPrieb(it.assignee) && it.status !== 'completed');

  const bySlug = {};
  items.forEach(it => {
    (bySlug[it.slug] = bySlug[it.slug] || []).push({
      id: it.id, room: it.room, item: it.item, notes: it.notes, status: it.status,
    });
  });

  return jobs
    .filter(j => bySlug[j.slug] && bySlug[j.slug].length)
    .map(j => ({
      slug: j.slug,
      address: j.address,
      closingDate: j.closingDate,
      // Sheet row order is dictation order is walk order — leave it alone.
      items: bySlug[j.slug],
    }))
    .sort((a, b) => {
      const ka = closingKey(a), kb = closingKey(b);
      if (ka && kb) return ka < kb ? -1 : ka > kb ? 1 : 0;
      if (ka) return -1;
      if (kb) return 1;
      return 0;
    });
}

// ── Claude API — dictation parsing ─────────────────────────────────

function parseDictation(dictation) {
  const systemPrompt = `You parse a superintendent's rambled voice-memo transcript from a home punch-list walkthrough into structured items.

OUTPUT: respond with ONLY a raw JSON object, no markdown fences, no preamble. Shape:
{
  "closingDate": "YYYY-MM-DD or null if not mentioned",
  "items": [
    { "room": "...", "item": "...", "assignee": "...", "status": "assignable" }
  ]
}

RULES:
- The closing date, if stated, is usually mentioned first ("closing is the 27th", "we close August 27th"). Convert to YYYY-MM-DD. Use null if not mentioned — never guess.
- room: the location, terse. Include a parenthetical sub-location or positional qualifier ONLY when needed to disambiguate from another item in the same base room (e.g. "Kitchen (dry bar)", "First Bedroom Upstairs (front)"). Otherwise just the plain room name ("Kitchen", "Primary Bath").
- item: terse description of the task, "Room: Item" style content but just the item part here (room is separate). Strip filler words, hedging, and narration. If multiple closely related fixes were mentioned together for the same spot, you may combine them into one item string separated by semicolons — but do not combine unrelated items just to shorten the list.
- assignee: the trade, company, or person name as stated. If Chris says something is his own task to handle personally (e.g. "I need to", "I'll follow up on", "that's on me"), set assignee to "Chris" and status to "self_assigned".
- IN-HOUSE WORK: when Chris names "Prieb", "Prieb Homes", or calls something in-house, set assignee to exactly "Prieb" and leave status "assignable". This is work for his in-house helper, not a trade and not Chris's own follow-up — keep it distinct from the "Chris" / self_assigned case above, which is strictly for things only Chris can do.
- status: default "assignable". Use "self_assigned" per the rule above. Use "flagged" when the item is genuinely undetermined — assignee is unclear, it needs someone else's approval/evaluation before it can be assigned (e.g. cost approval, third-party evaluation), or Chris explicitly says he needs to follow up with someone (like his boss or the office) before it can be assigned as a task.
- Never invent an assignee. If genuinely unclear who owns an item, use status "flagged" and leave assignee as "Unassigned" or your best guess of who Chris said he needs to check with (e.g. "Office" if he says he's asking the office).
- One item per bullet-worthy issue. Don't merge unrelated rooms or unrelated tasks into one item.
- Keep language plain and short — this becomes an actual bulleted line sent to a trade contractor. No extra commentary, no restating the room name inside the item text.`;

  const payload = {
    model: CLAUDE_MODEL,
    max_tokens: 4000,
    system: systemPrompt,
    messages: [{ role: 'user', content: dictation }],
  };

  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const data = JSON.parse(res.getContentText());
  if (data.error) throw new Error('Claude API error: ' + data.error.message);

  const text = (data.content || []).map(c => c.text || '').join('');
  const cleaned = text.replace(/```json|```/g, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error('Could not parse Claude response as JSON: ' + cleaned.slice(0, 200));
  }

  const items = (parsed.items || []).map(it => ({
    id: Utilities.getUuid(),
    room: it.room || '',
    item: it.item || '',
    // Fold every in-house spelling down to one canonical assignee. The lane is
    // selected by this string, so "Prieb Homes" slipping through as its own name
    // would quietly create a second in-house lane that no helper list reads.
    assignee: isPrieb(it.assignee) ? PRIEB_CANONICAL : (it.assignee || 'Unassigned'),
    status: it.status || 'assignable',
    dateLogged: new Date().toISOString(),
    dateSent: '',
    notes: '',
    dateCompleted: '',
  }));

  return { closingDate: parsed.closingDate || null, items };
}
