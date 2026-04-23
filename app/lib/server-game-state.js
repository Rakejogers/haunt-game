import { mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { connect } from "@tursodatabase/database";
import {
	clampLeaderboardLimit,
	isValidInitials,
	LEADERBOARD_CAMPAIGN_ID,
	LEADERBOARD_LIMIT,
	sanitizeInitials,
} from "./leaderboard";
import { getNpcById } from "./npcs";
import { getSecretRevealText } from "./npc-secrets";
import { CAMPAIGN_WORLDS, DEFAULT_WORLD_ID, getNextWorld, getWorldById } from "./worlds";

const DATABASE_PATH = path.join(process.cwd(), "data", "leaderboard.sqlite");
const SESSION_COOKIE_NAME = "haunt_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const OBJECTIVE_GRANT_TTL_MS = 5 * 60 * 1000;
const INTEGRITY_VERSION = "server-attested-v1";
const MAX_ELAPSED_MS = 12 * 60 * 60 * 1000;
const ACTIVE_ATTEMPT_STATUSES = new Set(["in_progress", "completed", "submitted"]);
const GROK_SESSION_LIMITS = [
	{ bucketType: "session", windowMs: 5 * 60 * 1000, max: 3 },
	{ bucketType: "ip", windowMs: 60 * 60 * 1000, max: 10 },
];
const OBJECTIVE_COMPLETE_LIMITS = [
	{ bucketType: "session", windowMs: 10 * 60 * 1000, max: 10 },
	{ bucketType: "ip", windowMs: 60 * 60 * 1000, max: 30 },
];

let databasePromise = null;
let schemaPromise = null;

function createHttpError(status, message) {
	const error = new Error(message);
	error.status = status;
	return error;
}

function toNumber(value) {
	if (typeof value === "bigint") return Number(value);
	return Number(value);
}

function nowIso() {
	return new Date().toISOString();
}

function parseJsonArray(value) {
	if (!value) return [];

	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function normalizeCompletedWorldIds(value) {
	const validWorldIds = new Set(CAMPAIGN_WORLDS.map((world) => world.id));
	return parseJsonArray(value).filter((worldId) => validWorldIds.has(worldId));
}

function addCompletedWorldIds(completedWorldIds, worldId) {
	return completedWorldIds.includes(worldId)
		? completedWorldIds
		: [...completedWorldIds, worldId];
}

function buildCookieHeader(sessionId) {
	const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
	return `${SESSION_COOKIE_NAME}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}${secure}`;
}

function readCookieValue(request, name) {
	const directValue = request?.cookies?.get?.(name)?.value;
	if (directValue) return directValue;

	const rawCookie = request?.headers?.get?.("cookie");
	if (!rawCookie) return null;

	for (const part of rawCookie.split(";")) {
		const [rawName, ...rest] = part.trim().split("=");
		if (rawName !== name) continue;
		return decodeURIComponent(rest.join("="));
	}

	return null;
}

function getRequestIp(request) {
	const forwardedFor = request.headers.get("x-forwarded-for");
	if (forwardedFor) {
		return forwardedFor.split(",")[0].trim();
	}

	return request.headers.get("x-real-ip")?.trim() || "unknown";
}

function normalizeAttemptSummary(row) {
	if (!row) {
		return {
			attemptId: null,
			campaignId: LEADERBOARD_CAMPAIGN_ID,
			currentWorldId: DEFAULT_WORLD_ID,
			completedWorldIds: [],
			campaignComplete: false,
			status: "idle",
			rankedStatus: "not_started",
			startedAt: null,
			completedAt: null,
			submittedAt: null,
			invalidationReason: "",
			submittedEntryId: null,
			submittedDisplayInitials: "",
			playerRank: null,
			elapsedMs: null,
			integrityVersion: INTEGRITY_VERSION,
		};
	}

	const startedAt = row.started_at ?? null;
	const completedAt = row.completed_at ?? null;
	const submittedAt = row.submitted_at ?? null;
	const startedAtMs = startedAt ? Date.parse(startedAt) : null;
	const completedAtMs = completedAt ? Date.parse(completedAt) : null;
	const elapsedMs =
		Number.isFinite(startedAtMs) && Number.isFinite(completedAtMs)
			? Math.max(0, completedAtMs - startedAtMs)
			: null;
	const invalidationReason = String(row.invalidation_reason ?? "");
	let rankedStatus = "not_started";

	if (row.status === "submitted") rankedStatus = "submitted";
	else if (row.status === "completed") rankedStatus = "eligible_complete";
	else if (row.status === "in_progress") rankedStatus = "eligible_in_progress";
	else if (invalidationReason) rankedStatus = "invalidated";

		return {
			attemptId: row.id,
			campaignId: row.campaign_id,
			currentWorldId: row.current_world_id || DEFAULT_WORLD_ID,
		completedWorldIds: normalizeCompletedWorldIds(row.completed_world_ids),
		campaignComplete: Boolean(row.campaign_complete),
		status: row.status || "idle",
		rankedStatus,
		startedAt,
			completedAt,
			submittedAt,
			invalidationReason,
			submittedEntryId:
				row.submitted_entry_id != null && Number.isFinite(toNumber(row.submitted_entry_id))
				? toNumber(row.submitted_entry_id)
					: null,
			submittedDisplayInitials: String(row.submitted_display_initials ?? ""),
			playerRank:
				row.player_rank != null && Number.isFinite(toNumber(row.player_rank))
					? toNumber(row.player_rank)
					: null,
			elapsedMs,
			integrityVersion: INTEGRITY_VERSION,
		};
}

function normalizeLeaderboardEntry(row, rank) {
	return {
		id: toNumber(row.id),
		campaignId: row.campaign_id,
		attemptId: row.attempt_id,
		initialsBase: row.initials_base,
		displayInitials: row.display_initials,
		elapsedMs: toNumber(row.elapsed_ms),
		createdAt: row.created_at,
		integrityVersion: row.integrity_version,
		rank,
	};
}

async function getDatabase() {
	if (!databasePromise) {
		databasePromise = (async () => {
			await mkdir(path.dirname(DATABASE_PATH), { recursive: true });
			return connect(DATABASE_PATH);
		})();
	}

	return databasePromise;
}

async function ensureSchema() {
	if (!schemaPromise) {
		schemaPromise = (async () => {
			const db = await getDatabase();
			await db.exec(`
				CREATE TABLE IF NOT EXISTS player_sessions (
					session_id TEXT PRIMARY KEY,
					current_attempt_id TEXT,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL
				)
			`);
			await db.exec(`
				CREATE TABLE IF NOT EXISTS campaign_attempts (
					id TEXT PRIMARY KEY,
					session_id TEXT NOT NULL,
					campaign_id TEXT NOT NULL,
					current_world_id TEXT NOT NULL,
					completed_world_ids TEXT NOT NULL,
					campaign_complete INTEGER NOT NULL DEFAULT 0,
					status TEXT NOT NULL,
					started_at TEXT,
					completed_at TEXT,
					submitted_at TEXT,
					invalidation_reason TEXT NOT NULL DEFAULT '',
					submitted_entry_id INTEGER,
					submitted_display_initials TEXT NOT NULL DEFAULT '',
					player_rank INTEGER,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL
				)
			`);
			await db.exec(`
				CREATE INDEX IF NOT EXISTS campaign_attempts_session_status_idx
				ON campaign_attempts (session_id, status, updated_at)
			`);
			await db.exec(`
				CREATE TABLE IF NOT EXISTS objective_grants (
					id TEXT PRIMARY KEY,
					attempt_id TEXT NOT NULL,
					world_id TEXT NOT NULL,
					npc_id TEXT NOT NULL,
					secret_id TEXT NOT NULL,
					status TEXT NOT NULL,
					summary TEXT NOT NULL DEFAULT '',
					confidence REAL,
					issued_at TEXT NOT NULL,
					expires_at TEXT NOT NULL,
					consumed_at TEXT
				)
			`);
			await db.exec(`
				CREATE INDEX IF NOT EXISTS objective_grants_attempt_status_idx
				ON objective_grants (attempt_id, status, expires_at)
			`);
			await db.exec(`
				CREATE TABLE IF NOT EXISTS leaderboard_entries_v2 (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					campaign_id TEXT NOT NULL,
					attempt_id TEXT NOT NULL UNIQUE,
					initials_base TEXT NOT NULL,
					display_initials TEXT NOT NULL,
					elapsed_ms INTEGER NOT NULL,
					integrity_version TEXT NOT NULL,
					created_at TEXT NOT NULL,
					UNIQUE(campaign_id, display_initials)
				)
			`);
			await db.exec(`
				CREATE INDEX IF NOT EXISTS leaderboard_entries_v2_campaign_rank_idx
				ON leaderboard_entries_v2 (campaign_id, elapsed_ms, created_at, id)
			`);
			await db.exec(`
				CREATE TABLE IF NOT EXISTS rate_limit_events (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					action TEXT NOT NULL,
					bucket_type TEXT NOT NULL,
					bucket_value TEXT NOT NULL,
					created_at TEXT NOT NULL
				)
			`);
			await db.exec(`
				CREATE INDEX IF NOT EXISTS rate_limit_events_lookup_idx
				ON rate_limit_events (action, bucket_type, bucket_value, created_at)
			`);
		})();
	}

	return schemaPromise;
}

async function getSessionRow(db, sessionId) {
	if (!sessionId) return null;

	return db
		.prepare(`
			SELECT session_id, current_attempt_id, created_at, updated_at
			FROM player_sessions
			WHERE session_id = ?
		`)
		.get(sessionId);
}

async function createSession(db) {
	const sessionId = randomUUID();
	const timestamp = nowIso();

	await db
		.prepare(`
			INSERT INTO player_sessions (session_id, current_attempt_id, created_at, updated_at)
			VALUES (?, NULL, ?, ?)
		`)
		.run(sessionId, timestamp, timestamp);

	return {
		sessionId,
		setCookieHeader: buildCookieHeader(sessionId),
	};
}

async function touchSession(db, sessionId, currentAttemptId) {
	await db
		.prepare(`
			UPDATE player_sessions
			SET current_attempt_id = ?, updated_at = ?
			WHERE session_id = ?
		`)
		.run(currentAttemptId ?? null, nowIso(), sessionId);
}

async function getAttemptById(db, attemptId) {
	if (!attemptId) return null;

	return db
		.prepare(`
			SELECT
				id,
				session_id,
				campaign_id,
				current_world_id,
				completed_world_ids,
				campaign_complete,
				status,
				started_at,
				completed_at,
				submitted_at,
				invalidation_reason,
				submitted_entry_id,
				submitted_display_initials,
				player_rank,
				created_at,
				updated_at
			FROM campaign_attempts
			WHERE id = ?
		`)
		.get(attemptId);
}

async function getCurrentAttemptRow(db, sessionId) {
	const sessionRow = await getSessionRow(db, sessionId);
	if (!sessionRow?.current_attempt_id) return null;
	return getAttemptById(db, sessionRow.current_attempt_id);
}

async function requireCurrentAttempt(db, sessionId, attemptId) {
	const sessionRow = await getSessionRow(db, sessionId);
	if (!sessionRow?.current_attempt_id || sessionRow.current_attempt_id !== attemptId) {
		throw createHttpError(403, "That run is not active for this browser session.");
	}

	const attemptRow = await getAttemptById(db, attemptId);
	if (!attemptRow || attemptRow.session_id !== sessionId) {
		throw createHttpError(403, "That run is not active for this browser session.");
	}

	return attemptRow;
}

async function resolveDisplayInitials(db, campaignId, initialsBase) {
	const rows = await db
		.prepare(`
			SELECT display_initials
			FROM leaderboard_entries_v2
			WHERE campaign_id = ? AND display_initials LIKE ?
		`)
		.all(campaignId, `${initialsBase}%`);

	const usedInitials = new Set(
		rows.map((row) => String(row.display_initials ?? "").toUpperCase()),
	);

	if (!usedInitials.has(initialsBase)) {
		return initialsBase;
	}

	let nextSuffix = 1;

	for (const usedValue of usedInitials) {
		if (!usedValue.startsWith(initialsBase)) continue;
		const suffix = usedValue.slice(initialsBase.length);
		if (!suffix || !/^\d+$/.test(suffix)) continue;
		nextSuffix = Math.max(nextSuffix, Number(suffix));
	}

	return `${initialsBase}${nextSuffix + 1}`;
}

function validateCampaignId(campaignId) {
	if (campaignId !== LEADERBOARD_CAMPAIGN_ID) {
		throw createHttpError(400, "Unsupported leaderboard campaign.");
	}

	return campaignId;
}

function validateCompletionWindow(attemptSummary) {
	if (!attemptSummary.startedAt || !attemptSummary.completedAt) {
		throw createHttpError(409, "This run has not finished yet.");
	}

	if (!Number.isFinite(attemptSummary.elapsedMs) || attemptSummary.elapsedMs <= 0) {
		throw createHttpError(409, "This run does not have a valid finish time.");
	}

	if (attemptSummary.elapsedMs > MAX_ELAPSED_MS) {
		throw createHttpError(409, "This run falls outside the allowed time window.");
	}
}

async function recordRateLimitEvent(db, action, bucketType, bucketValue, createdAtIso) {
	await db
		.prepare(`
			INSERT INTO rate_limit_events (action, bucket_type, bucket_value, created_at)
			VALUES (?, ?, ?, ?)
		`)
		.run(action, bucketType, bucketValue, createdAtIso);
}

async function cleanupRateLimitHistory(db, cutoffIso) {
	await db
		.prepare(`
			DELETE FROM rate_limit_events
			WHERE created_at < ?
		`)
		.run(cutoffIso);
}

async function enforceRateLimits(db, { action, sessionId, ip, limits }) {
	const createdAtIso = nowIso();

	for (const limit of limits) {
		const bucketValue = limit.bucketType === "session" ? sessionId : ip;
		const windowStartIso = new Date(Date.now() - limit.windowMs).toISOString();
		const row = await db
			.prepare(`
				SELECT COUNT(*) AS count
				FROM rate_limit_events
				WHERE action = ?
					AND bucket_type = ?
					AND bucket_value = ?
					AND created_at >= ?
			`)
			.get(action, limit.bucketType, bucketValue, windowStartIso);
		const count = toNumber(row?.count ?? 0);

		if (count >= limit.max) {
			throw createHttpError(429, "Too many requests right now. Please wait a moment.");
		}
	}

	for (const limit of limits) {
		const bucketValue = limit.bucketType === "session" ? sessionId : ip;
		await recordRateLimitEvent(db, action, limit.bucketType, bucketValue, createdAtIso);
	}

	await cleanupRateLimitHistory(db, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
}

export async function getSessionContext(request) {
	await ensureSchema();
	const db = await getDatabase();
	const cookieSessionId = readCookieValue(request, SESSION_COOKIE_NAME);
	const existingSession = await getSessionRow(db, cookieSessionId);

	if (!existingSession) {
		return createSession(db);
	}

	await touchSession(db, existingSession.session_id, existingSession.current_attempt_id ?? null);

	return {
		sessionId: existingSession.session_id,
		setCookieHeader: null,
	};
}

export function getResponseCookieHeader(sessionContext) {
	return sessionContext?.setCookieHeader || null;
}

export async function getCurrentAttemptSummary(sessionId) {
	await ensureSchema();
	const db = await getDatabase();
	const attemptRow = await getCurrentAttemptRow(db, sessionId);
	return normalizeAttemptSummary(attemptRow);
}

export async function startOrResumeAttempt(sessionId) {
	await ensureSchema();
	const db = await getDatabase();
	const currentAttempt = await getCurrentAttemptRow(db, sessionId);

	if (currentAttempt && ACTIVE_ATTEMPT_STATUSES.has(currentAttempt.status)) {
		return normalizeAttemptSummary(currentAttempt);
	}

	const attemptId = randomUUID();
	const timestamp = nowIso();

	await db
		.prepare(`
			INSERT INTO campaign_attempts (
				id,
				session_id,
				campaign_id,
				current_world_id,
				completed_world_ids,
				campaign_complete,
				status,
				started_at,
				completed_at,
				submitted_at,
				invalidation_reason,
				submitted_entry_id,
				submitted_display_initials,
				player_rank,
				created_at,
				updated_at
			)
			VALUES (?, ?, ?, ?, ?, 0, 'in_progress', ?, NULL, NULL, '', NULL, '', NULL, ?, ?)
		`)
		.run(
			attemptId,
			sessionId,
			LEADERBOARD_CAMPAIGN_ID,
			DEFAULT_WORLD_ID,
			JSON.stringify([]),
			timestamp,
			timestamp,
			timestamp,
		);

	await touchSession(db, sessionId, attemptId);

	return normalizeAttemptSummary(await getAttemptById(db, attemptId));
}

export async function resetCurrentAttempt(sessionId) {
	await ensureSchema();
	const db = await getDatabase();
	const attemptRow = await getCurrentAttemptRow(db, sessionId);

	if (attemptRow) {
		await db
			.prepare(`
				UPDATE campaign_attempts
				SET status = CASE
						WHEN status = 'submitted' THEN status
						WHEN status = 'completed' THEN 'abandoned'
						ELSE 'abandoned'
					END,
					invalidation_reason = CASE
						WHEN invalidation_reason != '' THEN invalidation_reason
						ELSE 'reset'
					END,
					updated_at = ?
				WHERE id = ?
			`)
			.run(nowIso(), attemptRow.id);
	}

	await touchSession(db, sessionId, null);

	return normalizeAttemptSummary(null);
}

export async function getLeaderboardEntries(
	campaignId = LEADERBOARD_CAMPAIGN_ID,
	limit = LEADERBOARD_LIMIT,
) {
	validateCampaignId(campaignId);
	await ensureSchema();
	const db = await getDatabase();
	const safeLimit = clampLeaderboardLimit(limit);
	const rows = await db
		.prepare(`
			SELECT
				id,
				campaign_id,
				attempt_id,
				initials_base,
				display_initials,
				elapsed_ms,
				integrity_version,
				created_at
			FROM leaderboard_entries_v2
			WHERE campaign_id = ?
			ORDER BY elapsed_ms ASC, created_at ASC, id ASC
			LIMIT ?
		`)
		.all(campaignId, safeLimit);

	return rows.map((row, index) => normalizeLeaderboardEntry(row, index + 1));
}

export async function createGrokSessionMaterial({ sessionId, request, attemptId, worldId, npcId }) {
	await ensureSchema();
	const db = await getDatabase();
	const attemptRow = await requireCurrentAttempt(db, sessionId, attemptId);

	if (attemptRow.status !== "in_progress") {
		throw createHttpError(409, "Only active runs can start a live conversation.");
	}

	if (attemptRow.current_world_id !== worldId) {
		throw createHttpError(409, "That world is not the active step for this run.");
	}

	const activeWorld = getWorldById(worldId);
	if (activeWorld.npcId !== npcId) {
		throw createHttpError(409, "That NPC does not belong to the active world.");
	}

	await enforceRateLimits(db, {
		action: "grok_session",
		sessionId,
		ip: getRequestIp(request),
		limits: GROK_SESSION_LIMITS,
	});

	const activeNpc = getNpcById(npcId);
	const issuedAtIso = nowIso();
	const expiresAtIso = new Date(Date.now() + OBJECTIVE_GRANT_TTL_MS).toISOString();
	let grantRow = await db
		.prepare(`
			SELECT id, expires_at
			FROM objective_grants
			WHERE attempt_id = ?
				AND world_id = ?
				AND npc_id = ?
				AND status = 'issued'
				AND expires_at >= ?
			ORDER BY issued_at DESC
			LIMIT 1
		`)
		.get(attemptId, worldId, npcId, issuedAtIso);

	if (!grantRow) {
		const grantId = randomUUID();
		await db
			.prepare(`
				INSERT INTO objective_grants (
					id,
					attempt_id,
					world_id,
					npc_id,
					secret_id,
					status,
					summary,
					confidence,
					issued_at,
					expires_at,
					consumed_at
				)
				VALUES (?, ?, ?, ?, ?, 'issued', '', NULL, ?, ?, NULL)
			`)
			.run(
				grantId,
				attemptId,
				worldId,
				npcId,
				activeNpc.secretId,
				issuedAtIso,
				expiresAtIso,
			);
		grantRow = { id: grantId, expires_at: expiresAtIso };
	}

	return {
		objectiveGrantId: grantRow.id,
		expiresAt: grantRow.expires_at,
		instructions: {
			npcId,
			worldId,
		},
	};
}

export async function completeObjectiveGrant({
	sessionId,
	request,
	attemptId,
	objectiveGrantId,
	npcId,
	secretId,
	summary,
	confidence,
}) {
	await ensureSchema();
	const db = await getDatabase();
	await enforceRateLimits(db, {
		action: "objective_complete",
		sessionId,
		ip: getRequestIp(request),
		limits: OBJECTIVE_COMPLETE_LIMITS,
	});

	const attemptRow = await requireCurrentAttempt(db, sessionId, attemptId);
	if (attemptRow.status !== "in_progress") {
		throw createHttpError(409, "Only active runs can complete an objective.");
	}

	const activeWorld = getWorldById(attemptRow.current_world_id);
	if (activeWorld.npcId !== npcId) {
		throw createHttpError(409, "That NPC is not the active world objective.");
	}

	const activeNpc = getNpcById(npcId);
	if (activeNpc.secretId !== secretId) {
		throw createHttpError(409, "That secret does not match the active objective.");
	}

	const timestamp = nowIso();
	const grantRow = await db
		.prepare(`
			SELECT id, attempt_id, world_id, npc_id, secret_id, status, expires_at
			FROM objective_grants
			WHERE id = ?
		`)
		.get(objectiveGrantId);

	if (!grantRow || grantRow.attempt_id !== attemptId) {
		throw createHttpError(403, "That objective grant is not valid for this run.");
	}

	if (grantRow.status !== "issued") {
		throw createHttpError(409, "That objective grant has already been used.");
	}

	if (grantRow.world_id !== attemptRow.current_world_id || grantRow.npc_id !== npcId) {
		throw createHttpError(409, "That objective grant does not match the active objective.");
	}

	if (grantRow.secret_id !== secretId) {
		throw createHttpError(409, "That objective grant does not match the revealed secret.");
	}

	if (Date.parse(grantRow.expires_at) < Date.now()) {
		throw createHttpError(409, "That objective grant expired. Start a new conversation.");
	}

	const completedWorldIds = addCompletedWorldIds(
		normalizeCompletedWorldIds(attemptRow.completed_world_ids),
		activeWorld.id,
	);
	const nextWorld = getNextWorld(activeWorld.id);
	const campaignComplete = !nextWorld;
	const nextStatus = campaignComplete ? "completed" : "in_progress";

	await db
		.prepare(`
			UPDATE objective_grants
			SET status = 'consumed',
				summary = ?,
				confidence = ?,
				consumed_at = ?
			WHERE id = ?
		`)
		.run(String(summary ?? ""), Number(confidence ?? 0), timestamp, objectiveGrantId);

	await db
		.prepare(`
			UPDATE campaign_attempts
			SET current_world_id = ?,
				completed_world_ids = ?,
				campaign_complete = ?,
				status = ?,
				completed_at = ?,
				updated_at = ?
			WHERE id = ?
		`)
		.run(
			nextWorld?.id ?? activeWorld.id,
			JSON.stringify(completedWorldIds),
			campaignComplete ? 1 : 0,
			nextStatus,
			campaignComplete ? timestamp : null,
			timestamp,
			attemptId,
		);

	const updatedAttempt = await getAttemptById(db, attemptId);

	return {
		revealText: getSecretRevealText(secretId),
		nextWorldId: nextWorld?.id ?? null,
		campaignState: {
			currentWorldId: updatedAttempt.current_world_id,
			completedWorldIds,
			campaignComplete,
		},
		attempt: normalizeAttemptSummary(updatedAttempt),
		completedAt: updatedAttempt.completed_at ?? null,
		campaignComplete,
	};
}

export async function submitLeaderboardEntry({
	sessionId,
	attemptId,
	initials,
	limit = LEADERBOARD_LIMIT,
}) {
	await ensureSchema();
	const db = await getDatabase();
	const attemptRow = await requireCurrentAttempt(db, sessionId, attemptId);
	const attemptSummary = normalizeAttemptSummary(attemptRow);

	if (attemptSummary.status === "submitted") {
		throw createHttpError(409, "This run has already been submitted.");
	}

	if (attemptSummary.status !== "completed" || !attemptSummary.campaignComplete) {
		throw createHttpError(409, "Only fully completed runs can be submitted.");
	}

	validateCompletionWindow(attemptSummary);

	const cleanedInitials = sanitizeInitials(initials);
	if (!isValidInitials(cleanedInitials)) {
		throw createHttpError(400, "Initials must be exactly three letters.");
	}

	const displayInitials = await resolveDisplayInitials(
		db,
		LEADERBOARD_CAMPAIGN_ID,
		cleanedInitials,
	);
	const createdAt = nowIso();
	const elapsedMs = Math.trunc(attemptSummary.elapsedMs);
	const insertResult = await db
		.prepare(`
			INSERT INTO leaderboard_entries_v2 (
				campaign_id,
				attempt_id,
				initials_base,
				display_initials,
				elapsed_ms,
				integrity_version,
				created_at
			)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`)
		.run(
			LEADERBOARD_CAMPAIGN_ID,
			attemptId,
			cleanedInitials,
			displayInitials,
			elapsedMs,
			INTEGRITY_VERSION,
			createdAt,
		);

	const entryId = toNumber(insertResult.lastInsertRowid);
	const playerRankRow = await db
		.prepare(`
			SELECT COUNT(*) AS rank
			FROM leaderboard_entries_v2
			WHERE campaign_id = ?
				AND (
					elapsed_ms < ?
					OR (
						elapsed_ms = ?
						AND (
							created_at < ?
							OR (created_at = ? AND id <= ?)
						)
					)
				)
		`)
		.get(
			LEADERBOARD_CAMPAIGN_ID,
			elapsedMs,
			elapsedMs,
			createdAt,
			createdAt,
			entryId,
		);

	const playerRank = toNumber(playerRankRow?.rank ?? 0);

	await db
		.prepare(`
			UPDATE campaign_attempts
			SET status = 'submitted',
				submitted_at = ?,
				submitted_entry_id = ?,
				submitted_display_initials = ?,
				player_rank = ?,
				updated_at = ?
			WHERE id = ?
		`)
		.run(createdAt, entryId, displayInitials, playerRank, createdAt, attemptId);

	const updatedAttempt = normalizeAttemptSummary(await getAttemptById(db, attemptId));

	return {
		entry: normalizeLeaderboardEntry(
			{
				id: entryId,
				campaign_id: LEADERBOARD_CAMPAIGN_ID,
				attempt_id: attemptId,
				initials_base: cleanedInitials,
				display_initials: displayInitials,
				elapsed_ms: elapsedMs,
				integrity_version: INTEGRITY_VERSION,
				created_at: createdAt,
			},
			playerRank,
		),
		playerRank,
		entries: await getLeaderboardEntries(LEADERBOARD_CAMPAIGN_ID, limit),
		attempt: updatedAttempt,
	};
}
