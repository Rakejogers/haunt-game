import { DEFAULT_WORLD_ID } from "./worlds";

export const LEADERBOARD_CAMPAIGN_ID = "ledger-trail-v1";
export const LEADERBOARD_LIMIT = 10;
export const RUN_STORAGE_KEY = "haunt-game-run-state:v1";

export function sanitizeInitials(value) {
	return String(value ?? "")
		.toUpperCase()
		.replace(/[^A-Z]/g, "")
		.slice(0, 3);
}

export function isValidInitials(value) {
	return sanitizeInitials(value).length === 3;
}

export function clampLeaderboardLimit(value) {
	const numericValue = Number(value);

	if (!Number.isFinite(numericValue)) {
		return LEADERBOARD_LIMIT;
	}

	return Math.max(1, Math.min(50, Math.trunc(numericValue)));
}

export function formatElapsedTime(elapsedMs) {
	if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
		return "--:--.--";
	}

	const totalCentiseconds = Math.floor(elapsedMs / 10);
	const centiseconds = totalCentiseconds % 100;
	const totalSeconds = Math.floor(totalCentiseconds / 100);
	const seconds = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);
	const minutes = totalMinutes % 60;
	const hours = Math.floor(totalMinutes / 60);

	if (hours > 0) {
		return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(
			2,
			"0",
		)}:${String(seconds).padStart(2, "0")}.${String(centiseconds).padStart(
			2,
			"0",
		)}`;
	}

	return `${String(totalMinutes).padStart(2, "0")}:${String(seconds).padStart(
		2,
		"0",
	)}.${String(centiseconds).padStart(2, "0")}`;
}

export function isFreshCampaignState(campaign) {
	return (
		campaign?.currentWorldId === DEFAULT_WORLD_ID &&
		Array.isArray(campaign?.completedWorldIds) &&
		campaign.completedWorldIds.length === 0 &&
		!campaign?.campaignComplete &&
		!campaign?.pendingTransition
	);
}

export function getRunIneligibilityMessage(runState) {
	switch (runState?.invalidationReason) {
		case "page_reload":
			return "This completion does not qualify because the page was reloaded or the run resumed mid-attempt.";
		case "restored_progress":
			return "This completion does not qualify because it started from saved campaign progress instead of a fresh uninterrupted run.";
		case "already_submitted":
			return "This run has already been submitted to the leaderboard.";
		default:
			return "Only uninterrupted fresh runs that start at World 1 can be submitted.";
	}
}
