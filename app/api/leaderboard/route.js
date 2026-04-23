import {
	clampLeaderboardLimit,
	LEADERBOARD_CAMPAIGN_ID,
	LEADERBOARD_LIMIT,
} from "../../lib/leaderboard";
import {
	getLeaderboardEntries,
	submitLeaderboardEntry,
} from "../../lib/leaderboard-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(payload, status = 200) {
	return Response.json(payload, {
		status,
		headers: {
			"Cache-Control": "no-store",
		},
	});
}

function getErrorMessage(error, fallbackMessage) {
	if (error instanceof Error && error.message) {
		return error.message;
	}

	return fallbackMessage;
}

export async function GET(request) {
	try {
		const { searchParams } = new URL(request.url);
		const campaignId =
			searchParams.get("campaignId") ?? LEADERBOARD_CAMPAIGN_ID;
		const limit = clampLeaderboardLimit(
			searchParams.get("limit") ?? LEADERBOARD_LIMIT,
		);
		const entries = await getLeaderboardEntries(campaignId, limit);

		return json({
			campaignId,
			entries,
		});
	} catch (error) {
		return json(
			{
				error: getErrorMessage(
					error,
					"Unable to load the leaderboard right now.",
				),
			},
			error?.status ?? 500,
		);
	}
}

export async function POST(request) {
	try {
		const body = await request.json();
		const campaignId = body?.campaignId ?? LEADERBOARD_CAMPAIGN_ID;
		const result = await submitLeaderboardEntry({
			campaignId,
			initials: body?.initials,
			elapsedMs: body?.elapsedMs,
			limit: LEADERBOARD_LIMIT,
		});

		return json(
			{
				campaignId,
				entry: result.entry,
				playerRank: result.playerRank,
				entries: result.entries,
			},
			201,
		);
	} catch (error) {
		return json(
			{
				error: getErrorMessage(
					error,
					"Unable to submit that leaderboard entry.",
				),
			},
			error?.status ?? 500,
		);
	}
}
