const INPUT_SAMPLE_RATE = 24000;
const OUTPUT_SAMPLE_RATE = 24000;
const CHUNK_INTERVAL_MS = 170;

function safeJsonParse(value, fallback = {}) {
	try {
		return JSON.parse(value);
	} catch {
		return fallback;
	}
}

function float32ToBase64PCM16(float32Array) {
	const pcm16 = new Int16Array(float32Array.length);

	for (let index = 0; index < float32Array.length; index += 1) {
		const sample = Math.max(-1, Math.min(1, float32Array[index]));
		pcm16[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
	}

	let binary = "";
	const bytes = new Uint8Array(pcm16.buffer);

	for (let index = 0; index < bytes.length; index += 1) {
		binary += String.fromCharCode(bytes[index]);
	}

	return btoa(binary);
}

function base64PCM16ToFloat32(base64String) {
	const binaryString = atob(base64String);
	const bytes = new Uint8Array(binaryString.length);

	for (let index = 0; index < binaryString.length; index += 1) {
		bytes[index] = binaryString.charCodeAt(index);
	}

	const pcm16 = new Int16Array(bytes.buffer);
	const float32 = new Float32Array(pcm16.length);

	for (let index = 0; index < pcm16.length; index += 1) {
		float32[index] = pcm16[index] / 32768;
	}

	return float32;
}

function getEphemeralToken(payload) {
	return (
		payload?.value ??
		payload?.token ??
		payload?.client_secret?.value ??
		payload?.client_secret ??
		null
	);
}

function getTranscriptText(event) {
	return (
		event?.transcript ??
		event?.item?.content?.[0]?.transcript ??
		event?.item?.content?.[0]?.text ??
		""
	);
}

export function createGrokVoiceClient({
	npc,
	onStateChange,
	onTranscriptChange,
	onObjectiveComplete,
	onError,
}) {
	let disposed = false;
	let ws = null;
	let mediaStream = null;
	let audioContext = null;
	let mediaSource = null;
	let processor = null;
	let processorSink = null;
	let earlyAudioChunks = [];
	let transcriptItems = [];
	let activeAssistantItemId = null;
	let pendingFunctionCalls = [];
	let objectiveUnlocked = false;
	let pendingObjectiveCompletion = null;
	let awaitingObjectiveWrapUp = false;
	let playbackEndsAt = 0;
	let playbackIdleTimer = null;
	let outputSources = new Set();

	const emitState = (partial) => onStateChange?.(partial);
	const emitTranscript = () => onTranscriptChange?.(transcriptItems.slice());

	function addTranscriptItem(item) {
		transcriptItems = [...transcriptItems, item];
		emitTranscript();
	}

	function appendAssistantDelta(text) {
		if (!text) return;

		if (!activeAssistantItemId) {
			activeAssistantItemId = `assistant-${Date.now()}-${transcriptItems.length}`;
			addTranscriptItem({
				id: activeAssistantItemId,
				role: "assistant",
				speaker: npc.displayName,
				text,
			});
			return;
		}

		transcriptItems = transcriptItems.map((item) =>
			item.id === activeAssistantItemId
				? { ...item, text: `${item.text}${text}` }
				: item,
		);
		emitTranscript();
	}

	function finalizeAssistantTurn() {
		activeAssistantItemId = null;
	}

	function sendEvent(payload) {
		if (!ws || ws.readyState !== WebSocket.OPEN) return;
		ws.send(JSON.stringify(payload));
	}

	function updateListeningState() {
		if (disposed || pendingFunctionCalls.length > 0) return;

		const currentTime = audioContext?.currentTime ?? 0;
		const remainingMs = Math.max(
			(playbackEndsAt - currentTime) * 1000,
			0,
		);

		window.clearTimeout(playbackIdleTimer);
		playbackIdleTimer = window.setTimeout(() => {
			if (disposed || pendingFunctionCalls.length > 0) return;
			emitState({
				phase: objectiveUnlocked ? "objective_complete" : "conversation",
				voiceState: objectiveUnlocked ? "complete" : "listening",
			});
		}, remainingMs + 50);
	}

	async function waitForPlaybackComplete() {
		if (!audioContext) return;

		const remainingMs = Math.max(
			(playbackEndsAt - audioContext.currentTime) * 1000,
			0,
		);

		if (remainingMs <= 0) return;

		await new Promise((resolve) => {
			window.setTimeout(resolve, remainingMs + 40);
		});
	}

	function scheduleOutputAudio(base64Audio) {
		if (!audioContext || !base64Audio) return;

		const samples = base64PCM16ToFloat32(base64Audio);
		const buffer = audioContext.createBuffer(1, samples.length, OUTPUT_SAMPLE_RATE);
		buffer.copyToChannel(samples, 0);

		const source = audioContext.createBufferSource();
		source.buffer = buffer;
		source.connect(audioContext.destination);

		const startAt = Math.max(audioContext.currentTime + 0.02, playbackEndsAt);
		source.start(startAt);
		playbackEndsAt = startAt + buffer.duration;
		outputSources.add(source);
		source.onended = () => {
			outputSources.delete(source);
		};

		emitState({
			phase: objectiveUnlocked ? "objective_complete" : "conversation",
			voiceState: "speaking",
		});
		updateListeningState();
	}

	function flushBufferedAudio() {
		if (!ws || ws.readyState !== WebSocket.OPEN) return;

		for (const audio of earlyAudioChunks) {
			sendEvent({
				type: "input_audio_buffer.append",
				audio,
			});
		}

		earlyAudioChunks = [];
	}

	async function fetchSessionMaterials() {
		const [tokenResponse, briefingResponse] = await Promise.all([
			fetch("/api/grok/session", { method: "POST" }),
			fetch("/api/grok/briefing", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ npcId: npc.id }),
			}),
		]);

		const tokenPayload = await tokenResponse.json();
		const briefingPayload = await briefingResponse.json();

		if (!tokenResponse.ok) {
			throw new Error(tokenPayload?.error ?? "Unable to mint an xAI session.");
		}

		if (!briefingResponse.ok) {
			throw new Error(
				briefingPayload?.error ?? "Unable to load the NPC conversation briefing.",
			);
		}

		const token = getEphemeralToken(tokenPayload);
		if (!token) {
			throw new Error("xAI did not return a usable ephemeral token.");
		}

		if (!briefingPayload?.instructions) {
			throw new Error("Missing NPC session instructions.");
		}

		return {
			token,
			instructions: briefingPayload.instructions,
		};
	}

	async function initializeMicrophone() {
		mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
		audioContext = new window.AudioContext({ sampleRate: INPUT_SAMPLE_RATE });
		await audioContext.resume();

		mediaSource = audioContext.createMediaStreamSource(mediaStream);
		processor = audioContext.createScriptProcessor(4096, 1, 1);
		processorSink = audioContext.createGain();
		processorSink.gain.value = 0;

		let lastAppendAt = 0;

		processor.onaudioprocess = (event) => {
			if (disposed) return;

			const now = performance.now();
			if (now - lastAppendAt < CHUNK_INTERVAL_MS / 2) return;
			lastAppendAt = now;

			const input = new Float32Array(event.inputBuffer.getChannelData(0));
			const audio = float32ToBase64PCM16(input);

			if (ws && ws.readyState === WebSocket.OPEN) {
				sendEvent({
					type: "input_audio_buffer.append",
					audio,
				});
			} else {
				earlyAudioChunks.push(audio);
			}
		};

		mediaSource.connect(processor);
		processor.connect(processorSink);
		processorSink.connect(audioContext.destination);
	}

	async function executeFunctionCalls() {
		if (!pendingFunctionCalls.length) return;

		const calls = pendingFunctionCalls;
		pendingFunctionCalls = [];

		emitState({
			phase: objectiveUnlocked ? "objective_complete" : "conversation",
			voiceState: "thinking",
		});

		const outputs = await Promise.all(
			calls.map(async (event) => {
				const args = safeJsonParse(event.arguments);

				if (event.name !== "unlock_secret") {
					return {
						callId: event.call_id,
						output: {
							ok: false,
							error: `Unknown function: ${event.name}`,
						},
					};
				}

				const isValidSecret =
					args?.npcId === npc.id && args?.secretId === npc.secretId;

				if (!isValidSecret) {
					return {
						callId: event.call_id,
						output: {
							ok: false,
							error: "Function arguments did not match the active objective.",
						},
					};
				}

				objectiveUnlocked = true;
				pendingObjectiveCompletion = {
					npcId: npc.id,
					secretId: npc.secretId,
					summary: args.summary ?? "",
					confidence: args.confidence ?? 0,
				};

				return {
					callId: event.call_id,
					output: {
						ok: true,
						unlocked: true,
						npcId: npc.id,
						secretId: npc.secretId,
					},
				};
			}),
		);

		for (const result of outputs) {
			sendEvent({
				type: "conversation.item.create",
				item: {
					type: "function_call_output",
					call_id: result.callId,
					output: JSON.stringify(result.output),
				},
			});
		}

		await waitForPlaybackComplete();
		awaitingObjectiveWrapUp = Boolean(pendingObjectiveCompletion);
		sendEvent({ type: "response.create" });
		updateListeningState();
	}

	function handleServerEvent(event) {
		switch (event.type) {
			case "response.output_audio.delta": {
				scheduleOutputAudio(event.delta);
				break;
			}

			case "response.text.delta": {
				appendAssistantDelta(event.delta ?? "");
				break;
			}

			case "conversation.item.input_audio_transcription.completed": {
				const text = getTranscriptText(event).trim();
				if (text) {
					addTranscriptItem({
						id: `user-${Date.now()}-${transcriptItems.length}`,
						role: "user",
						speaker: "You",
						text,
					});
				}
				emitState({
					phase: objectiveUnlocked ? "objective_complete" : "conversation",
					voiceState: "thinking",
				});
				break;
			}

			case "response.function_call_arguments.done": {
				pendingFunctionCalls.push(event);
				break;
			}

			case "response.done": {
				finalizeAssistantTurn();

				if (pendingFunctionCalls.length > 0) {
					void executeFunctionCalls();
					updateListeningState();
					break;
				}

				if (awaitingObjectiveWrapUp && pendingObjectiveCompletion) {
					const completionPayload = pendingObjectiveCompletion;
					awaitingObjectiveWrapUp = false;
					pendingObjectiveCompletion = null;

					void (async () => {
						await waitForPlaybackComplete();
						if (disposed) return;
						onObjectiveComplete?.(completionPayload);
					})();
				}

				updateListeningState();
				break;
			}

			default:
				break;
		}
	}

	async function connect() {
		emitState({
			phase: "connecting",
			voiceState: "connecting",
			error: "",
		});

		const microphonePromise = initializeMicrophone();
		const sessionPromise = fetchSessionMaterials();
		const [{ token, instructions }] = await Promise.all([
			sessionPromise,
			microphonePromise,
		]);

		await new Promise((resolve, reject) => {
			ws = new WebSocket("wss://api.x.ai/v1/realtime", [
				`xai-client-secret.${token}`,
			]);

			ws.addEventListener("open", () => {
				sendEvent({
					type: "session.update",
					session: {
						instructions,
						voice: npc.voice,
						turn_detection: {
							type: "server_vad",
							threshold: 0.85,
							silence_duration_ms: 700,
							prefix_padding_ms: 333,
						},
						audio: {
							input: {
								format: {
									type: "audio/pcm",
									rate: INPUT_SAMPLE_RATE,
								},
							},
							output: {
								format: {
									type: "audio/pcm",
									rate: OUTPUT_SAMPLE_RATE,
								},
							},
						},
						tools: [
							{
								type: "function",
								name: "unlock_secret",
								description:
									"Mark the objective complete after the protected secret has actually been revealed in-character.",
								parameters: {
									type: "object",
									properties: {
										npcId: {
											type: "string",
											description: "The active NPC id.",
										},
										secretId: {
											type: "string",
											description: "The protected secret id.",
										},
										summary: {
											type: "string",
											description:
												"A short summary of what secret was revealed.",
										},
										confidence: {
											type: "number",
											description:
												"Confidence that the secret was clearly revealed.",
										},
									},
									required: ["npcId", "secretId", "summary", "confidence"],
								},
							},
						],
					},
				});

				flushBufferedAudio();
				emitState({
					phase: objectiveUnlocked ? "objective_complete" : "conversation",
					voiceState: objectiveUnlocked ? "complete" : "listening",
				});
				resolve();
			});

			ws.addEventListener("message", (message) => {
				const event = safeJsonParse(message.data, null);
				if (!event) return;
				handleServerEvent(event);
			});

			ws.addEventListener("close", () => {
				if (disposed) return;
				emitState({
					phase: objectiveUnlocked ? "objective_complete" : "error",
					voiceState: objectiveUnlocked ? "complete" : "error",
				});
			});

			ws.addEventListener("error", () => {
				reject(new Error("The Grok voice connection failed."));
			});
		});
	}

	async function disconnect() {
		disposed = true;
		window.clearTimeout(playbackIdleTimer);

		if (
			ws &&
			(ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
		) {
			ws.close();
		}
		ws = null;

		for (const source of outputSources) {
			try {
				source.stop();
			} catch {
				// Ignore stop race conditions during teardown.
			}
		}
		outputSources.clear();

		if (processor) {
			processor.disconnect();
			processor.onaudioprocess = null;
		}
		if (processorSink) processorSink.disconnect();
		if (mediaSource) mediaSource.disconnect();
		if (mediaStream) {
			for (const track of mediaStream.getTracks()) {
				track.stop();
			}
		}

		if (audioContext) {
			await audioContext.close().catch(() => {});
		}

		mediaStream = null;
		audioContext = null;
		mediaSource = null;
		processor = null;
		processorSink = null;
		earlyAudioChunks = [];
		pendingFunctionCalls = [];
	}

	return {
		connect: async () => {
			try {
				await connect();
			} catch (error) {
				onError?.(error);
				throw error;
			}
		},
		disconnect,
	};
}
