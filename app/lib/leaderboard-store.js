import { mkdir } from "node:fs/promises";
import path from "node:path";
import { connect } from "@tursodatabase/database";
import {
	clampLeaderboardLimit,
	isValidInitials,
	LEADERBOARD_CAMPAIGN_ID,
	LEADERBOARD_LIMIT,
	sanitizeInitials,
} from "./leaderboard";

const LEADERBOARD_DB_PATH = path.join(process.cwd(), "data", "leaderboard.sqlite");
const MAX_ELAPSED_MS = 12 * 60 * 60 * 1000;

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

function normalizeEntry(row, rank) {
	return {
		id: toNumber(row.id),
		campaignId: row.campaign_id,
		initialsBase: row.initials_base,
		displayInitials: row.display_initials,
		elapsedMs: toNumber(row.elapsed_ms),
		createdAt: row.created_at,
		rank,
	};
}

async function getDatabase() {
	if (!databasePromise) {
		databasePromise = (async () => {
			await mkdir(path.dirname(LEADERBOARD_DB_PATH), { recursive: true });
			return connect(LEADERBOARD_DB_PATH);
		})();
	}

	return databasePromise;
}

async function ensureSchema() {
	if (!schemaPromise) {
		schemaPromise = (async () => {
			const db = await getDatabase();
			await db.exec(`
				CREATE TABLE IF NOT EXISTS leaderboard_entries (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					campaign_id TEXT NOT NULL,
					initials_base TEXT NOT NULL,
					display_initials TEXT NOT NULL,
					elapsed_ms INTEGER NOT NULL,
					created_at TEXT NOT NULL,
					UNIQUE(campaign_id, display_initials)
				)
			`);
			await db.exec(`
				CREATE INDEX IF NOT EXISTS leaderboard_entries_campaign_rank_idx
				ON leaderboard_entries (campaign_id, elapsed_ms, created_at, id)
			`);
		})();
	}

	return schemaPromise;
}

function validateCampaignId(campaignId) {
	if (campaignId !== LEADERBOARD_CAMPAIGN_ID) {
		throw createHttpError(400, "Unsupported leaderboard campaign.");
	}

	return campaignId;
}

function validateElapsedMs(elapsedMs) {
	const numericValue = Number(elapsedMs);

	if (!Number.isFinite(numericValue) || numericValue <= 0) {
		throw createHttpError(400, "A valid elapsed time is required.");
	}

	if (numericValue > MAX_ELAPSED_MS) {
		throw createHttpError(400, "The submitted time is outside the allowed range.");
	}

	return Math.trunc(numericValue);
}

async function resolveDisplayInitials(db, campaignId, initialsBase) {
	const rows = await db
		.prepare(`
			SELECT display_initials
			FROM leaderboard_entries
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
				initials_base,
				display_initials,
				elapsed_ms,
				created_at
			FROM leaderboard_entries
			WHERE campaign_id = ?
			ORDER BY elapsed_ms ASC, created_at ASC, id ASC
			LIMIT ?
		`)
		.all(campaignId, safeLimit);

	return rows.map((row, index) => normalizeEntry(row, index + 1));
}

export async function submitLeaderboardEntry({
	campaignId = LEADERBOARD_CAMPAIGN_ID,
	initials,
	elapsedMs,
	limit = LEADERBOARD_LIMIT,
}) {
	validateCampaignId(campaignId);

	const cleanedInitials = sanitizeInitials(initials);
	if (!isValidInitials(cleanedInitials)) {
		throw createHttpError(400, "Initials must be exactly three letters.");
	}

	const safeElapsedMs = validateElapsedMs(elapsedMs);

	await ensureSchema();
	const db = await getDatabase();
	const displayInitials = await resolveDisplayInitials(
		db,
		campaignId,
		cleanedInitials,
	);
	const createdAt = new Date().toISOString();

	const insertResult = await db
		.prepare(`
			INSERT INTO leaderboard_entries (
				campaign_id,
				initials_base,
				display_initials,
				elapsed_ms,
				created_at
			)
			VALUES (?, ?, ?, ?, ?)
		`)
		.run(campaignId, cleanedInitials, displayInitials, safeElapsedMs, createdAt);

	const entryId = toNumber(insertResult.lastInsertRowid);
	const playerRankRow = await db
		.prepare(`
			SELECT COUNT(*) AS rank
			FROM leaderboard_entries
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
			campaignId,
			safeElapsedMs,
			safeElapsedMs,
			createdAt,
			createdAt,
			entryId,
		);

	const playerRank = toNumber(playerRankRow?.rank ?? 0);
	const entry = normalizeEntry(
		{
			id: entryId,
			campaign_id: campaignId,
			initials_base: cleanedInitials,
			display_initials: displayInitials,
			elapsed_ms: safeElapsedMs,
			created_at: createdAt,
		},
		playerRank,
	);

	return {
		entry,
		playerRank,
		entries: await getLeaderboardEntries(campaignId, limit),
	};
}
