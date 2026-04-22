"use client";

import { useEffect, useRef, useState } from "react";
import { createGrokVoiceClient } from "./lib/grok-voice-client";
import { DEFAULT_NPC } from "./lib/npcs";

const DEFAULT_SESSION_STATE = {
	phase: "exploration",
	voiceState: "idle",
	activeNpcId: DEFAULT_NPC.id,
	transcriptItems: [],
	objectiveComplete: false,
	error: "",
	canInteract: false,
	overlayOpen: false,
};

function getStatusLabel(session) {
	if (session.error) return "Error";
	if (session.objectiveComplete) return "Complete";

	switch (session.voiceState) {
		case "connecting":
			return "Connecting";
		case "thinking":
			return "Thinking";
		case "speaking":
			return "Speaking";
		case "listening":
			return "Listening";
		default:
			return "Idle";
	}
}

export default function TavernGame() {
	const containerRef = useRef(null);
	const startButtonRef = useRef(null);
	const infoRef = useRef(null);
	const loadingRef = useRef(null);
	const volumeButtonRef = useRef(null);
	const reticleRef = useRef(null);
	const runtimeControllerRef = useRef(null);
	const voiceClientRef = useRef(null);
	const [loadError, setLoadError] = useState("");
	const [sceneReady, setSceneReady] = useState(false);
	const [session, setSession] = useState(DEFAULT_SESSION_STATE);
	const sessionRef = useRef(DEFAULT_SESSION_STATE);

	useEffect(() => {
		sessionRef.current = session;
	}, [session]);

	useEffect(() => {
		let cancelled = false;
		let cleanup = null;

		async function mount() {
			try {
				const { mountTavernScene } = await import(
					/* webpackIgnore: true */ "/tavern-scene-runtime.js"
				);
				if (cancelled || !containerRef.current) return;

				const controller = await mountTavernScene({
					container: containerRef.current,
					npc: DEFAULT_NPC,
					ui: {
						startButton: startButtonRef.current,
						infoElement: infoRef.current,
						loadingElement: loadingRef.current,
						volumeButton: volumeButtonRef.current,
						reticle: reticleRef.current,
					},
					callbacks: {
						onSceneReadyChange: (ready) => {
							setSceneReady(Boolean(ready));
						},
						onInteractionStateChange: ({ canInteract }) => {
							setSession((previous) => {
								if (previous.overlayOpen) {
									return { ...previous, canInteract };
								}

								const nextPhase = canInteract
									? "prompt_visible"
									: previous.objectiveComplete
										? "objective_complete"
										: "exploration";

								return {
									...previous,
									canInteract,
									phase: nextPhase,
								};
							});
						},
						onInteractionRequested: ({ npcId }) => {
							if (npcId !== DEFAULT_NPC.id) return;
							void beginConversation();
						},
					},
				});

				if (cancelled) {
					controller?.dispose?.();
					return;
				}

				runtimeControllerRef.current = controller;
				cleanup = controller?.dispose;
			} catch (error) {
				console.error("Failed to mount tavern scene:", error);
				if (!cancelled) {
					setLoadError(
						"Unable to load the haunt scene. Check the console for details.",
					);
				}
			}
		}

		mount();

		return () => {
			cancelled = true;
			void voiceClientRef.current?.disconnect?.();
			voiceClientRef.current = null;
			runtimeControllerRef.current = null;
			cleanup?.();
		};
	}, []);

	useEffect(() => {
		function handleEscape(event) {
			if (event.code !== "Escape" || !sessionRef.current.overlayOpen) return;
			event.preventDefault();
			void closeConversation();
		}

		window.addEventListener("keydown", handleEscape);
		return () => window.removeEventListener("keydown", handleEscape);
	}, []);

	async function beginConversation() {
		if (voiceClientRef.current || loadError) return;

		runtimeControllerRef.current?.setConversationActive?.(true);
		runtimeControllerRef.current?.setMusicDuckFactor?.(0.25);

		setSession((previous) => ({
			...previous,
			phase: previous.objectiveComplete ? "objective_complete" : "connecting",
			voiceState: "connecting",
			error: "",
			overlayOpen: true,
			activeNpcId: DEFAULT_NPC.id,
			transcriptItems: [],
		}));

		const client = createGrokVoiceClient({
			npc: DEFAULT_NPC,
			onStateChange: (partial) => {
				setSession((previous) => ({
					...previous,
					...partial,
					error: partial.error ?? previous.error,
					overlayOpen: true,
				}));
			},
			onTranscriptChange: (transcriptItems) => {
				setSession((previous) => ({
					...previous,
					transcriptItems,
				}));
			},
			onObjectiveComplete: () => {
				setSession((previous) => ({
					...previous,
					phase: "objective_complete",
					voiceState: "complete",
					objectiveComplete: true,
				}));
			},
			onError: (error) => {
				setSession((previous) => ({
					...previous,
					phase: "error",
					voiceState: "error",
					error:
						error instanceof Error
							? error.message
							: "The Grok voice session failed.",
					overlayOpen: true,
				}));
			},
		});

		voiceClientRef.current = client;

		try {
			await client.connect();
		} catch (error) {
			console.error("Unable to start Grok voice session:", error);
			voiceClientRef.current = null;
			await client.disconnect?.();
			runtimeControllerRef.current?.setConversationActive?.(false);
			runtimeControllerRef.current?.setMusicDuckFactor?.(1);
		}
	}

	async function closeConversation() {
		const client = voiceClientRef.current;
		voiceClientRef.current = null;
		await client?.disconnect?.();

		runtimeControllerRef.current?.setConversationActive?.(false);
		runtimeControllerRef.current?.setMusicDuckFactor?.(1);
		runtimeControllerRef.current?.resumePointerLock?.();

		setSession((previous) => ({
			...previous,
			overlayOpen: false,
			error: "",
			voiceState: previous.objectiveComplete ? "complete" : "idle",
			phase: previous.canInteract ? "prompt_visible" : "exploration",
		}));
	}

	const statusLabel = getStatusLabel(session);
	const showInteractionPrompt =
		session.canInteract && !session.overlayOpen && !loadError;
	const startButtonLabel = sceneReady ? "Enter the room" : "Preparing the room...";

	return (
		<main className="tavernPage">
			<div ref={containerRef} className="tavernCanvasRoot" />
			<div ref={infoRef} className="tavernInfo">
				<button
					ref={startButtonRef}
					className="tavernButton"
					type="button"
					disabled={!sceneReady}
				>
					{startButtonLabel}
				</button>
				<p className="tavernHint">
					{sceneReady
						? "Enter the room to start moving. If mouse-look does not engage, click the scene once. Then walk up to Don Malvek and press "
						: "Loading the collider, splats, and NPC before you can enter. Then enter the room, click the scene if needed for mouse-look, and press "}
					<kbd>E</kbd>
					{" "}when you are close enough to talk.
				</p>
			</div>
			<button
				ref={volumeButtonRef}
				className="tavernVolumeButton"
				type="button"
				aria-label="Toggle volume"
				title="Toggle volume"
			>
				🔊
			</button>
			<div ref={reticleRef} className="tavernReticle" />
			{showInteractionPrompt ? (
				<div className="tavernPrompt">Press E to talk</div>
			) : null}
			<div ref={loadingRef} className="tavernLoading">
				<div className="tavernSpinner" />
				Loading splats...
			</div>
			<div className="tavernObjective">
				<span className="tavernObjectiveLabel">Objective</span>
				<p>{DEFAULT_NPC.objectiveLabel}</p>
			</div>
			{session.overlayOpen ? (
				<section className="conversationPanel">
					<div className="conversationHeader">
						<div>
							<p className="conversationEyebrow">Live Conversation</p>
							<h2>{DEFAULT_NPC.displayName}</h2>
						</div>
						<div className="conversationHeaderActions">
							<span
								className={`conversationStatus conversationStatus--${statusLabel.toLowerCase()}`}
							>
								{statusLabel}
							</span>
							<button
								type="button"
								className="conversationClose"
								onClick={() => void closeConversation()}
							>
								Close
							</button>
						</div>
					</div>
					<p className="conversationObjective">{DEFAULT_NPC.objectiveLabel}</p>
					<div className="conversationTranscript">
						{session.transcriptItems.length ? (
							session.transcriptItems.map((item) => (
								<article
									key={item.id}
									className={`conversationBubble conversationBubble--${item.role}`}
								>
									<p className="conversationSpeaker">{item.speaker}</p>
									<p>{item.text}</p>
								</article>
							))
						) : (
							<p className="conversationEmpty">
								The room goes quiet. Start talking when you are ready.
							</p>
						)}
					</div>
					<div className="conversationFooter">
						<p className="conversationHint">
							Press <kbd>Esc</kbd> to leave the conversation.
						</p>
						{session.error ? (
							<p className="conversationError">{session.error}</p>
						) : null}
						{session.objectiveComplete ? (
							<p className="conversationSuccess">
								Objective complete. You pulled the secret out of him.
							</p>
						) : null}
					</div>
				</section>
			) : null}
			{loadError ? <p className="tavernError">{loadError}</p> : null}
		</main>
	);
}
