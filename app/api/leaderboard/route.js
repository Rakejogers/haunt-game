import {
	clampLeaderboardLimit,
	LEADERBOARD_CAMPAIGN_ID,
	LEADERBOARD_LIMIT,
} from "../../lib/leaderboard";
import {
	getResponseCookieHeader,
	getLeaderboardEntries,
	getSessionContext,
	submitLeaderboardEntry,
} from "../../lib/server-game-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(payload, status = 200, sessionCookie = null) {
	return Response.json(payload, {
		status,
		headers: {
			"Cache-Control": "no-store",
			...(sessionCookie ? { "Set-Cookie": sessionCookie } : {}),
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
		const sessionContext = await getSessionContext(request);
		const { searchParams } = new URL(request.url);
		const campaignId =
			searchParams.get("campaignId") ?? LEADERBOARD_CAMPAIGN_ID;
		const limit = clampLeaderboardLimit(
			searchParams.get("limit") ?? LEADERBOARD_LIMIT,
		);
		const entries = await getLeaderboardEntries(campaignId, limit);

		return json(
			{
				campaignId,
				entries,
			},
			200,
			getResponseCookieHeader(sessionContext),
		);
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
		const sessionContext = await getSessionContext(request);
		const body = await request.json();
		const result = await submitLeaderboardEntry({
			sessionId: sessionContext.sessionId,
			attemptId: body?.attemptId,
			initials: body?.initials,
			limit: LEADERBOARD_LIMIT,
		});

		return json(
			{
				campaignId: LEADERBOARD_CAMPAIGN_ID,
				entry: result.entry,
				playerRank: result.playerRank,
				entries: result.entries,
				attemptStatus: result.attempt,
			},
			201,
			getResponseCookieHeader(sessionContext),
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
