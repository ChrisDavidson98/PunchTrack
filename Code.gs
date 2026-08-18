/**
 * WALKTHROUGH ITEMS TRACKER — Apps Script backend
 * ================================================
 * Mirrors the Scope Deviation backend's pattern:
 *  - GET  requests => read actions   (listJobs, getJob)
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
 * Jobs:  slug | address | closingDate | createdAt | lastUpdated
 * Items: id | slug | room | item | assignee | status | dateLogged | dateSent | notes
 *   status ∈ "assignable" | "flagged" | "self_assigned" | "sent"
 *   (an assignable item becomes "sent" once its report ships; flagged/self_assigned
 *    items are tracked but never auto-transition to "sent" via report-shipping —
 *    self_assigned items get marked sent when Chris ships/acknowledges his own list;
 *    flagged items only leave "flagged" when manually resolved in the UI)
 */

const PROPS = PropertiesService.getScriptProperties();
const SHEET_ID = PROPS.getProperty('SHEET_ID');
const APP_TOKEN = PROPS.getProperty('APP_TOKEN');
const CLAUDE_API_KEY = PROPS.getProperty('CLAUDE_API_KEY');
const CLAUDE_MODEL = 'claude-sonnet-4-5-20250929'; // update if you want a different model

const JOBS_SHEET = 'Jobs';
const ITEMS_SHEET = 'Items';

const JOBS_HEADERS = ['slug', 'address', 'closingDate', 'createdAt', 'lastUpdated'];
const ITEMS_HEADERS = ['id', 'slug', 'room', 'item', 'assignee', 'status', 'dateLogged', 'dateSent', 'notes', 'dateCompleted'];

// ── Entry points ─────────────────────────────────────────────────

function doGet(e) {
  try {
    const params = e.parameter;
    checkToken(params.token);
    const action = params.action;

    if (action === 'listJobs') return respond(listJobs());
    if (action === 'getJob') return respond(getJob(params.slug));

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

    if (action === 'createJob') return respond(createJob(body.job));
    if (action === 'saveJob') return respond(saveJob(body.job));
    if (action === 'deleteJob') return respond(deleteJob(body.slug));
    if (action === 'parseDictation') return respond(parseDictation(body.dictation));
    if (action === 'saveItems') return respond(saveItems(body.slug, body.items));
    if (action === 'shipReport') return respond(shipReport(body.slug, body.assignee));
    if (action === 'resolveFlag') return respond(resolveFlag(body.itemId, body.resolution));
    if (action === 'updateItem') return respond(updateItem(body.item));
    if (action === 'parseConfirmation') return respond(parseConfirmation(body.dictation, body.openItems));
    if (action === 'applyConfirmations') return respond(applyConfirmations(body.matches));

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

function getSheet(name, headers) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
  }
  return sh;
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

function objectsToSheet(sh, headers, objects) {
  sh.clear();
  sh.appendRow(headers);
  if (objects.length === 0) return;
  const rows = objects.map(o => headers.map(h => (o[h] !== undefined && o[h] !== null ? o[h] : '')));
  sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
}

// ── Jobs ─────────────────────────────────────────────────────────

function listJobs() {
  const sh = getSheet(JOBS_SHEET, JOBS_HEADERS);
  return sheetToObjects(sh).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
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

function saveItems(slug, items) {
  const sh = getSheet(ITEMS_SHEET, ITEMS_HEADERS);
  const all = sheetToObjects(sh).filter(it => it.slug !== slug); // drop old rows for this job
  const merged = all.concat(items.map(it => ({ ...it, slug })));
  objectsToSheet(sh, ITEMS_HEADERS, merged);
  return { ok: true, count: items.length };
}

function shipReport(slug, assignee) {
  const sh = getSheet(ITEMS_SHEET, ITEMS_HEADERS);
  const items = sheetToObjects(sh);
  const now = new Date().toISOString();
  const updated = items.map(it => {
    if (it.slug === slug && it.assignee === assignee && it.status === 'assignable') {
      return { ...it, status: 'sent', dateSent: now };
    }
    return it;
  });
  objectsToSheet(sh, ITEMS_HEADERS, updated);
  return { ok: true };
}

function resolveFlag(itemId, resolution) {
  // resolution: { newAssignee, newStatus } — reassign to "assignable" or close as "sent"/other
  const sh = getSheet(ITEMS_SHEET, ITEMS_HEADERS);
  const items = sheetToObjects(sh);
  const updated = items.map(it => {
    if (it.id === itemId) {
      return {
        ...it,
        assignee: resolution.newAssignee !== undefined ? resolution.newAssignee : it.assignee,
        status: resolution.newStatus || it.status,
        notes: resolution.notes !== undefined ? resolution.notes : it.notes,
      };
    }
    return it;
  });
  objectsToSheet(sh, ITEMS_HEADERS, updated);
  return { ok: true };
}

// General single-item field editor — used for manual edits after save, and for
// tap-to-complete (pass { id, status: "completed", dateCompleted: <iso> }).
function updateItem(item) {
  const sh = getSheet(ITEMS_SHEET, ITEMS_HEADERS);
  const items = sheetToObjects(sh);
  const updated = items.map(it => (it.id === item.id ? { ...it, ...item } : it));
  objectsToSheet(sh, ITEMS_HEADERS, updated);
  return { ok: true };
}

// Confirm Pass: match a dictated revisit update against the currently-open
// items (assignable/sent) for a job, so a revisit can mark items complete or
// append context WITHOUT creating duplicate rows.
function parseConfirmation(dictation, openItems) {
  const systemPrompt = `You help a superintendent log a revisit/confirmation pass against a punch list.

You are given a list of currently-open items (each with an id, room, and item description) and a rambled voice-memo transcript where the superintendent describes what he found on a revisit — some items now done, some still pending with new context, some not mentioned at all (leave those alone).

OUTPUT: respond with ONLY a raw JSON object, no markdown fences, no preamble. Shape:
{
  "matches": [
    { "id": "<id of the matched open item>", "action": "complete" or "note", "note": "short note text, or empty string if action is complete with nothing extra to add" }
  ],
  "unmatched": ["any dictated snippet you could not confidently match to one of the given open items"]
}

RULES:
- Match by meaning, not exact wording — "grout in the kitchen is done" matches an open item like "Kitchen: Grout caulking touch up".
- action "complete": the superintendent clearly said this item is now finished/fixed/done.
- action "note": the superintendent gave an update but the item is NOT yet done (still pending, waiting on something, partially done) — capture that update tersely in "note", do not mark complete.
- Never invent a match. If you're not confident which open item a snippet refers to, put the raw snippet in "unmatched" instead of guessing.
- Only return entries for items actually mentioned in the dictation — do not return anything for items not discussed.

OPEN ITEMS:
${JSON.stringify(openItems)}`;

  const payload = {
    model: CLAUDE_MODEL,
    max_tokens: 3000,
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

  return { matches: parsed.matches || [], unmatched: parsed.unmatched || [] };
}

// Applies a reviewed/edited set of Confirm Pass matches to the Items sheet.
// matches: [{ id, action: "complete"|"note", note }]
function applyConfirmations(matches) {
  const sh = getSheet(ITEMS_SHEET, ITEMS_HEADERS);
  const items = sheetToObjects(sh);
  const now = new Date().toISOString();
  const updated = items.map(it => {
    const m = (matches || []).find(x => x.id === it.id);
    if (!m) return it;
    if (m.action === 'complete') {
      return {
        ...it,
        status: 'completed',
        dateCompleted: now,
        notes: m.note ? ((it.notes ? it.notes + ' | ' : '') + m.note) : it.notes,
      };
    }
    if (m.action === 'note') {
      return { ...it, notes: (it.notes ? it.notes + ' | ' : '') + (m.note || '') };
    }
    return it;
  });
  objectsToSheet(sh, ITEMS_HEADERS, updated);
  return { ok: true };
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
    assignee: it.assignee || 'Unassigned',
    status: it.status || 'assignable',
    dateLogged: new Date().toISOString(),
    dateSent: '',
    notes: '',
  }));

  return { closingDate: parsed.closingDate || null, items };
}
