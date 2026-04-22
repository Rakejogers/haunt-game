export const runtime = "nodejs";

const SESSION_REQUEST_URL = "https://api.x.ai/v1/realtime/client_secrets";

export async function POST() {
	const apiKey = process.env.XAI_API_KEY;

	if (!apiKey) {
		return Response.json(
			{
				error:
					"Missing XAI_API_KEY. Add it to your environment before starting a Grok session.",
			},
			{ status: 500 },
		);
	}

	try {
		const upstreamResponse = await fetch(SESSION_REQUEST_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				expires_after: {
					seconds: 300,
				},
			}),
			cache: "no-store",
		});

		const payload = await upstreamResponse.json();

		if (!upstreamResponse.ok) {
			return Response.json(
				{
					error: "xAI rejected the ephemeral token request.",
					details: payload,
				},
				{ status: upstreamResponse.status },
			);
		}

		return Response.json(payload, {
			status: 200,
			headers: {
				"Cache-Control": "no-store",
			},
		});
	} catch (error) {
		return Response.json(
			{
				error: "Failed to contact xAI while creating an ephemeral token.",
				details: error instanceof Error ? error.message : "Unknown error",
			},
			{ status: 500 },
		);
	}
}
