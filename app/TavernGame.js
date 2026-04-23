"use client";

import { useEffect, useRef, useState } from "react";
import {
	formatElapsedTime,
	getRunIneligibilityMessage,
	isFreshCampaignState,
	isValidInitials,
	LEADERBOARD_CAMPAIGN_ID,
	LEADERBOARD_LIMIT,
	RUN_STORAGE_KEY,
	sanitizeInitials,
} from "./lib/leaderboard";
import { createGrokVoiceClient } from "./lib/grok-voice-client";
import { getNpcById } from "./lib/npcs";
import { CAMPAIGN_WORLDS, DEFAULT_WORLD_ID, getWorldById } from "./lib/worlds";

const CAMPAIGN_STORAGE_KEY = "haunt-game-campaign-progress:v3";

const DEFAULT_UI_STATE = {
	phase: "exploration",
	voiceState: "idle",
	activeNpcId: "",
	transcriptItems: [],
	error: "",
	canInteract: false,
	overlayOpen: false,
};

const DEFAULT_CAMPAIGN_STATE = {
	currentWorldId: DEFAULT_WORLD_ID,
	completedWorldIds: [],
	campaignComplete: false,
	pendingTransition: null,
};

const DEFAULT_RUN_STATE = {
	attemptId: "",
	campaignId: LEADERBOARD_CAMPAIGN_ID,
	status: "idle",
	rankedStatus: "not_started",
	startedAtMs: null,
	completedAtMs: null,
	submittedAtMs: null,
	submittedEntryId: null,
	submittedDisplayInitials: "",
	playerRank: null,
	invalidationReason: "",
};

const DEFAULT_LEADERBOARD_STATE = {
	entries: [],
	loading: false,
	error: "",
	initials: "",
	submitting: false,
	submitError: "",
	playerEntry: null,
	playerRank: null,
};

function createUiState({
	activeNpcId,
	objectiveComplete = false,
	campaignComplete = false,
}) {
	return {
		...DEFAULT_UI_STATE,
		activeNpcId,
		phase: campaignComplete
			? "campaign_complete"
			: objectiveComplete
				? "objective_complete"
				: "exploration",
		voiceState: objectiveComplete || campaignComplete ? "complete" : "idle",
	};
}

function getStatusLabel(session, objectiveComplete, campaignComplete) {
	if (session.error) return "Error";
	if (objectiveComplete || campaignComplete) return "Complete";

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

function normalizeRuntimeEnvironment(value) {
	return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isDebugRuntimeEnvironment(value) {
	const normalizedValue = normalizeRuntimeEnvironment(value);
	return normalizedValue === "dev" || normalizedValue === "development";
}

function isDefaultCampaignState(campaign) {
	return (
		campaign.currentWorldId === DEFAULT_WORLD_ID &&
		Array.isArray(campaign.completedWorldIds) &&
		campaign.completedWorldIds.length === 0 &&
		!campaign.campaignComplete &&
		!campaign.pendingTransition
	);
}

function persistProgress(progress) {
	if (typeof window === "undefined") return;

	window.localStorage.setItem(
		CAMPAIGN_STORAGE_KEY,
		JSON.stringify({
			currentWorldId: progress.currentWorldId,
			completedWorldIds: progress.completedWorldIds,
			campaignComplete: progress.campaignComplete,
		}),
	);
}

function clearStoredProgress() {
	if (typeof window === "undefined") return;
	window.localStorage.removeItem(CAMPAIGN_STORAGE_KEY);
}

function persistRunState(runState) {
	if (typeof window === "undefined") return;
	window.localStorage.setItem(RUN_STORAGE_KEY, JSON.stringify(runState));
}

function clearStoredRunState() {
	if (typeof window === "undefined") return;
	window.localStorage.removeItem(RUN_STORAGE_KEY);
}

function buildCampaignStateFromAttempt(attemptSummary) {
	if (!attemptSummary?.attemptId) {
		return DEFAULT_CAMPAIGN_STATE;
	}

	return {
		currentWorldId: attemptSummary.currentWorldId || DEFAULT_WORLD_ID,
		completedWorldIds: Array.isArray(attemptSummary.completedWorldIds)
			? attemptSummary.completedWorldIds
			: [],
		campaignComplete: Boolean(attemptSummary.campaignComplete),
		pendingTransition: null,
	};
}

function buildRunStateFromAttempt(attemptSummary) {
	if (!attemptSummary?.attemptId) {
		return DEFAULT_RUN_STATE;
	}

	return {
		attemptId: attemptSummary.attemptId,
		campaignId: attemptSummary.campaignId || LEADERBOARD_CAMPAIGN_ID,
		status: attemptSummary.status || "idle",
		rankedStatus: attemptSummary.rankedStatus || "not_started",
		startedAtMs: attemptSummary.startedAt ? Date.parse(attemptSummary.startedAt) : null,
		completedAtMs: attemptSummary.completedAt
			? Date.parse(attemptSummary.completedAt)
			: null,
		submittedAtMs: attemptSummary.submittedAt
			? Date.parse(attemptSummary.submittedAt)
			: null,
		submittedEntryId: Number.isFinite(attemptSummary.submittedEntryId)
			? Number(attemptSummary.submittedEntryId)
			: null,
		submittedDisplayInitials: attemptSummary.submittedDisplayInitials || "",
		playerRank: Number.isFinite(attemptSummary.playerRank)
			? Number(attemptSummary.playerRank)
			: null,
		invalidationReason: attemptSummary.invalidationReason || "",
	};
}

function createPendingTransition(fromWorldId, toWorldId) {
	if (!toWorldId) return null;

	const fromWorld = getWorldById(fromWorldId);
	const nextWorld = getWorldById(toWorldId);

	return {
		fromWorldId,
		toWorldId,
		title: fromWorld.transitionTitle,
		body: fromWorld.transitionBody,
		nextWorldName: nextWorld.name,
		nextObjectiveLabel: nextWorld.objectiveLabel,
	};
}

function getDebugRunStateLabel(runState) {
	switch (runState.status) {
		case "in_progress":
			return "Eligible in progress";
		case "completed":
			return "Eligible complete";
		case "submitted":
			return "Submitted";
		default:
			return runState.attemptId ? "Unavailable" : "Not started";
	}
}

async function requestJson(url, options = {}, fallbackMessage) {
	const response = await fetch(url, {
		cache: "no-store",
		...options,
	});
	const payload = await response.json().catch(() => ({}));

	if (!response.ok) {
		throw new Error(payload?.error || fallbackMessage);
	}

	return payload;
}

export default function TavernGame({ runtimeEnvironment = "" }) {
	const containerRef = useRef(null);
	const startButtonRef = useRef(null);
	const infoRef = useRef(null);
	const loadingRef = useRef(null);
	const volumeButtonRef = useRef(null);
	const reticleRef = useRef(null);
	const runtimeControllerRef = useRef(null);
	const voiceClientRef = useRef(null);
	const campaignRef = useRef(DEFAULT_CAMPAIGN_STATE);
	const sessionRef = useRef(DEFAULT_UI_STATE);
	const runRef = useRef(DEFAULT_RUN_STATE);
	const startAttemptPromiseRef = useRef(null);

	const [loadError, setLoadError] = useState("");
	const [sceneReady, setSceneReady] = useState(false);
	const [progressReady, setProgressReady] = useState(false);
	const [campaign, setCampaign] = useState(DEFAULT_CAMPAIGN_STATE);
	const [runState, setRunState] = useState(DEFAULT_RUN_STATE);
	const [leaderboard, setLeaderboard] = useState(DEFAULT_LEADERBOARD_STATE);
	const [debugMenuOpen, setDebugMenuOpen] = useState(false);

	const initialWorld = getWorldById(DEFAULT_WORLD_ID);
	const initialNpc = getNpcById(initialWorld.npcId);
	const [session, setSession] = useState(() =>
		createUiState({ activeNpcId: initialNpc.id }),
	);
	const normalizedRuntimeEnvironment = normalizeRuntimeEnvironment(runtimeEnvironment);
	const debugModeEnabled = isDebugRuntimeEnvironment(runtimeEnvironment);

	function applyCampaignState(nextCampaign) {
		campaignRef.current = nextCampaign;
		setCampaign(nextCampaign);
	}

	function applyRunState(nextRunState) {
		runRef.current = nextRunState;
		setRunState(nextRunState);
	}

	function syncFromAttemptSummary(attemptSummary) {
		applyCampaignState(buildCampaignStateFromAttempt(attemptSummary));
		applyRunState(buildRunStateFromAttempt(attemptSummary));
	}

	useEffect(() => {
		campaignRef.current = campaign;
	}, [campaign]);

	useEffect(() => {
		sessionRef.current = session;
	}, [session]);

	useEffect(() => {
		runRef.current = runState;
	}, [runState]);

	useEffect(() => {
		if (!progressReady) return;

		if (runState.attemptId || !isDefaultCampaignState(campaign)) {
			persistProgress(campaign);
		} else {
			clearStoredProgress();
		}

		if (runState.attemptId) {
			persistRunState(runState);
		} else {
			clearStoredRunState();
		}
	}, [campaign, progressReady, runState]);

	useEffect(() => {
		let cancelled = false;

		async function hydrateAttempt() {
			setLoadError("");

			try {
				const payload = await requestJson(
					"/api/attempt/current",
					{},
					"Unable to restore the secure run state.",
				);
				if (cancelled) return;
				syncFromAttemptSummary(payload?.attempt ?? null);
			} catch (error) {
				if (cancelled) return;
				console.error("Failed to restore secure run state:", error);
				syncFromAttemptSummary(null);
				setLoadError(
					error instanceof Error
						? error.message
						: "Unable to restore the secure run state.",
				);
			} finally {
				if (!cancelled) {
					setProgressReady(true);
				}
			}
		}

		void hydrateAttempt();

		return () => {
			cancelled = true;
		};
	}, []);

	const activeWorld = getWorldById(campaign.currentWorldId);
	const activeNpc = getNpcById(activeWorld.npcId);
	const objectiveComplete = campaign.completedWorldIds.includes(activeWorld.id);
	const currentWorldIndex = CAMPAIGN_WORLDS.findIndex(
		(world) => world.id === activeWorld.id,
	);
	const statusLabel = getStatusLabel(
		session,
		objectiveComplete,
		campaign.campaignComplete,
	);
	const showInteractionPrompt =
		progressReady &&
		session.canInteract &&
		!session.overlayOpen &&
		!loadError &&
		!objectiveComplete &&
		!campaign.pendingTransition &&
		!campaign.campaignComplete;
	const startButtonLabel = !progressReady
		? "Restoring secure run..."
		: sceneReady
			? `Enter ${activeWorld.name}`
			: `Preparing ${activeWorld.name}...`;
	const finalElapsedMs =
		Number.isFinite(runState.startedAtMs) && Number.isFinite(runState.completedAtMs)
			? Math.max(0, runState.completedAtMs - runState.startedAtMs)
			: null;
	const canSubmitScore =
		campaign.campaignComplete &&
		runState.status === "completed" &&
		Boolean(runState.attemptId) &&
		!runState.submittedAtMs;
	const leaderboardMessage = runState.submittedAtMs
		? `Submitted as ${runState.submittedDisplayInitials || "your score"}.`
		: getRunIneligibilityMessage(runState);
	const debugRunStateLabel = getDebugRunStateLabel(runState);

	useEffect(() => {
		if (!progressReady) return;

		setSession(
			createUiState({
				activeNpcId: activeNpc.id,
				objectiveComplete,
				campaignComplete: campaign.campaignComplete,
			}),
		);
	}, [
		activeNpc.id,
		activeWorld.id,
		campaign.campaignComplete,
		objectiveComplete,
		progressReady,
	]);

	async function ensureAttemptStarted() {
		if (runRef.current.attemptId) {
			return {
				attemptId: runRef.current.attemptId,
			};
		}

		if (!isFreshCampaignState(campaignRef.current)) {
			throw new Error(
				"This run does not have a secure attempt. Reset and start again from World 1.",
			);
		}

		if (startAttemptPromiseRef.current) {
			return startAttemptPromiseRef.current;
		}

		startAttemptPromiseRef.current = (async () => {
			const payload = await requestJson(
				"/api/attempt/start",
				{ method: "POST" },
				"Unable to start a secure run right now.",
			);
			syncFromAttemptSummary(payload?.attempt ?? null);
			return payload?.attempt ?? null;
		})();

		try {
			return await startAttemptPromiseRef.current;
		} finally {
			startAttemptPromiseRef.current = null;
		}
	}

	useEffect(() => {
		if (!progressReady) return;

		let cancelled = false;
		let cleanup = null;

		setLoadError("");
		setSceneReady(false);

		async function mount() {
			try {
				const { mountTavernScene } = await import(
					/* webpackIgnore: true */ "/tavern-scene-runtime.js"
				);
				if (cancelled || !containerRef.current) return;

				const controller = await mountTavernScene({
					container: containerRef.current,
					world: activeWorld,
					npc: activeNpc,
					ui: {
						startButton: startButtonRef.current,
						infoElement: infoRef.current,
						loadingElement: loadingRef.current,
						volumeButton: volumeButtonRef.current,
						reticle: reticleRef.current,
					},
					callbacks: {
						onRunStarted: () => {
							if (!isFreshCampaignState(campaignRef.current)) return;
							if (runRef.current.attemptId) return;

							void ensureAttemptStarted().catch((error) => {
								console.error("Unable to secure the run start:", error);
							});
						},
						onSceneReadyChange: (ready) => {
							setSceneReady(Boolean(ready));
						},
						onInteractionStateChange: ({ canInteract }) => {
							setSession((previous) => {
								if (previous.overlayOpen) {
									return { ...previous, canInteract };
								}

								const currentCampaign = campaignRef.current;
								const currentWorldComplete = currentCampaign.completedWorldIds.includes(
									activeWorld.id,
								);
								const nextPhase = canInteract
									? "prompt_visible"
									: currentCampaign.campaignComplete || currentWorldComplete
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
							const currentCampaign = campaignRef.current;
							const currentWorldComplete = currentCampaign.completedWorldIds.includes(
								activeWorld.id,
							);

							if (npcId !== activeNpc.id) return;
							if (currentWorldComplete) return;
							if (currentCampaign.pendingTransition) return;
							if (currentCampaign.campaignComplete) return;

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
				console.error("Failed to mount haunt scene:", error);
				if (!cancelled) {
					setLoadError(
						"Unable to load the active world. Check the console for details.",
					);
				}
			}
		}

		void mount();

		return () => {
			cancelled = true;
			void voiceClientRef.current?.disconnect?.();
			voiceClientRef.current = null;
			runtimeControllerRef.current = null;
			cleanup?.();
		};
	}, [activeNpc.id, activeWorld.id, progressReady]);

	useEffect(() => {
		function handleEscape(event) {
			if (event.code !== "Escape" || !sessionRef.current.overlayOpen) return;
			event.preventDefault();
			void closeConversation();
		}

		window.addEventListener("keydown", handleEscape);
		return () => window.removeEventListener("keydown", handleEscape);
	}, []);

	useEffect(() => {
		if (!debugModeEnabled) return;

		function handleDebugShortcut(event) {
			if (event.code !== "Backquote") return;
			if (event.metaKey || event.ctrlKey || event.altKey) return;

			event.preventDefault();
			setDebugMenuOpen((previous) => !previous);
		}

		window.addEventListener("keydown", handleDebugShortcut);
		return () => window.removeEventListener("keydown", handleDebugShortcut);
	}, [debugModeEnabled]);

	useEffect(() => {
		if (!campaign.campaignComplete) return;

		let cancelled = false;

		async function loadLeaderboard() {
			setLeaderboard((previous) => ({
				...previous,
				loading: true,
				error: "",
			}));

			try {
				const payload = await requestJson(
					`/api/leaderboard?campaignId=${encodeURIComponent(
						LEADERBOARD_CAMPAIGN_ID,
					)}&limit=${LEADERBOARD_LIMIT}`,
					{},
					"Unable to load the leaderboard.",
				);

				if (cancelled) return;

				setLeaderboard((previous) => ({
					...previous,
					loading: false,
					error: "",
					entries: Array.isArray(payload.entries) ? payload.entries : [],
					playerRank: previous.playerRank ?? runRef.current.playerRank,
				}));
			} catch (error) {
				if (cancelled) return;

				setLeaderboard((previous) => ({
					...previous,
					loading: false,
					error:
						error instanceof Error
							? error.message
							: "Unable to load the leaderboard.",
				}));
			}
		}

		void loadLeaderboard();

		return () => {
			cancelled = true;
		};
	}, [campaign.campaignComplete]);

	async function teardownConversation(nextPhase) {
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
			voiceState:
				nextPhase === "objective_complete" || nextPhase === "campaign_complete"
					? "complete"
					: "idle",
			phase: nextPhase,
		}));
	}

	async function beginConversation() {
		if (voiceClientRef.current || loadError || !progressReady) return;
		if (campaignRef.current.pendingTransition || campaignRef.current.campaignComplete) {
			return;
		}
		if (campaignRef.current.completedWorldIds.includes(activeWorld.id)) return;

		runtimeControllerRef.current?.setConversationActive?.(true);
		runtimeControllerRef.current?.setMusicDuckFactor?.(0.25);

		setSession((previous) => ({
			...previous,
			phase: "connecting",
			voiceState: "connecting",
			error: "",
			overlayOpen: true,
			activeNpcId: activeNpc.id,
			transcriptItems: [],
		}));

		try {
			const attempt = await ensureAttemptStarted();
			if (!attempt?.attemptId && !runRef.current.attemptId) {
				throw new Error("Unable to secure this conversation. Reset and try again.");
			}

			const client = createGrokVoiceClient({
				npc: activeNpc,
				attemptId: attempt?.attemptId ?? runRef.current.attemptId,
				worldId: activeWorld.id,
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
				onObjectiveComplete: (payload) => {
					void completeObjective(payload);
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
			await client.connect();
		} catch (error) {
			console.error("Unable to start Grok voice session:", error);
			const client = voiceClientRef.current;
			voiceClientRef.current = null;
			await client?.disconnect?.();
			runtimeControllerRef.current?.setConversationActive?.(false);
			runtimeControllerRef.current?.setMusicDuckFactor?.(1);
			setSession((previous) => ({
				...previous,
				phase: "error",
				voiceState: "error",
				error:
					error instanceof Error
						? error.message
						: "Unable to start the secure conversation.",
				overlayOpen: true,
			}));
		}
	}

	async function completeObjective(completionPayload) {
		const nextWorldId = completionPayload?.nextWorldId ?? null;
		const nextWorld = nextWorldId ? getWorldById(nextWorldId) : null;
		const completedWorldIds = Array.isArray(completionPayload?.campaignState?.completedWorldIds)
			? completionPayload.campaignState.completedWorldIds
			: campaignRef.current.completedWorldIds;

		if (completionPayload?.revealText) {
			setSession((previous) => ({
				...previous,
				transcriptItems: [
					...previous.transcriptItems,
					{
						id: `reveal-${Date.now()}`,
						role: "assistant",
						speaker: activeNpc.displayName,
						text: completionPayload.revealText,
					},
				],
			}));
		}

		await teardownConversation(nextWorld ? "objective_complete" : "campaign_complete");

		applyRunState(buildRunStateFromAttempt(completionPayload?.attempt ?? null));
		applyCampaignState({
			currentWorldId: activeWorld.id,
			completedWorldIds,
			campaignComplete: Boolean(completionPayload?.campaignComplete),
			pendingTransition: nextWorld
				? createPendingTransition(activeWorld.id, nextWorld.id)
				: null,
		});
	}

	async function closeConversation() {
		const currentCampaign = campaignRef.current;
		const currentWorldComplete = currentCampaign.completedWorldIds.includes(
			activeWorld.id,
		);
		const nextPhase = currentCampaign.campaignComplete
			? "campaign_complete"
			: currentWorldComplete
				? "objective_complete"
				: sessionRef.current.canInteract
					? "prompt_visible"
					: "exploration";

		await teardownConversation(nextPhase);
	}

	function continueToNextWorld() {
		const transition = campaign.pendingTransition;
		if (!transition) return;

		applyCampaignState({
			currentWorldId: transition.toWorldId,
			completedWorldIds: campaign.completedWorldIds,
			campaignComplete: false,
			pendingTransition: null,
		});
	}

	async function resetCampaign() {
		await teardownConversation("exploration");

		try {
			const payload = await requestJson(
				"/api/attempt/reset",
				{ method: "POST" },
				"Unable to reset the secure run right now.",
			);
			setLoadError("");
			setLeaderboard(DEFAULT_LEADERBOARD_STATE);
			syncFromAttemptSummary(payload?.attempt ?? null);
			setSession(
				createUiState({
					activeNpcId: getNpcById(getWorldById(DEFAULT_WORLD_ID).npcId).id,
				}),
			);
		} catch (error) {
			setLoadError(
				error instanceof Error
					? error.message
					: "Unable to reset the secure run right now.",
			);
		}
	}

	async function submitLeaderboardScore(event) {
		event.preventDefault();

		if (!canSubmitScore || !runState.attemptId) return;
		if (!isValidInitials(leaderboard.initials)) {
			setLeaderboard((previous) => ({
				...previous,
				submitError: "Enter exactly three letters for your initials.",
			}));
			return;
		}

		setLeaderboard((previous) => ({
			...previous,
			submitting: true,
			submitError: "",
			error: "",
		}));

		try {
			const payload = await requestJson(
				"/api/leaderboard",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						attemptId: runState.attemptId,
						initials: leaderboard.initials,
					}),
				},
				"Unable to submit your score.",
			);

			applyRunState(buildRunStateFromAttempt(payload?.attemptStatus ?? null));
			setLeaderboard((previous) => ({
				...previous,
				submitting: false,
				submitError: "",
				error: "",
				entries: Array.isArray(payload?.entries) ? payload.entries : [],
				playerEntry: payload?.entry ?? null,
				playerRank: payload?.playerRank ?? null,
			}));
		} catch (error) {
			setLeaderboard((previous) => ({
				...previous,
				submitting: false,
				submitError:
					error instanceof Error
						? error.message
						: "Unable to submit your score.",
			}));
		}
	}

	return (
		<main className="tavernPage">
			<div ref={containerRef} className="tavernCanvasRoot" />
			<div ref={infoRef} className="tavernInfo">
				<button
					ref={startButtonRef}
					className="tavernButton"
					type="button"
					disabled={!sceneReady || !progressReady}
				>
					{startButtonLabel}
				</button>
				<p className="tavernHint">
					{progressReady ? (
						sceneReady ? (
							<>
								Enter {activeWorld.name} to start moving. If mouse-look does not
								engage, click the scene once. Then walk up to{" "}
								{activeNpc.displayName} and press <kbd>E</kbd> when you are close
								enough to talk.
							</>
						) : (
							<>
								Loading the world, splats, music, and NPC for {activeWorld.name}.
								Then enter the scene and press <kbd>E</kbd> when you are close
								enough to talk.
							</>
						)
					) : (
						"Restoring your secure campaign progress..."
					)}
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
				{progressReady ? `Loading ${activeWorld.name}...` : "Restoring secure run..."}
			</div>
			<div className="tavernObjective">
				<span className="tavernObjectiveLabel">Current World</span>
				<p className="tavernObjectiveWorld">{activeWorld.name}</p>
				<p>
					{campaign.campaignComplete
						? "All configured worlds are complete."
						: activeWorld.objectiveLabel}
				</p>
				<p className="tavernObjectiveMeta">
					World {currentWorldIndex + 1} of {CAMPAIGN_WORLDS.length}
				</p>
				{runState.startedAtMs && !campaign.campaignComplete ? (
					<p className="tavernObjectiveMeta">
						Ranked run: {runState.status === "in_progress" ? "eligible" : "locked"}
					</p>
				) : null}
				<button
					type="button"
					className="tavernSecondaryButton"
					onClick={() => void resetCampaign()}
				>
					Reset run
				</button>
			</div>
			{debugModeEnabled ? (
				<section className={`debugPanel ${debugMenuOpen ? "debugPanel--open" : ""}`}>
					<button
						type="button"
						className="debugPanelToggle"
						onClick={() => setDebugMenuOpen((previous) => !previous)}
					>
						{debugMenuOpen ? "Close Dev Menu" : "Open Dev Menu"}
					</button>
					{debugMenuOpen ? (
						<div className="debugPanelCard">
							<div className="debugPanelHeader">
								<div>
									<p className="debugPanelEyebrow">Debug Controls</p>
									<h2>Secure runtime</h2>
								</div>
								<p className="debugPanelShortcut">Press ` to toggle</p>
							</div>
							<div className="debugPanelStatusGrid">
								<div>
									<p className="debugPanelLabel">Runtime</p>
									<p>{normalizedRuntimeEnvironment || "unset"}</p>
								</div>
								<div>
									<p className="debugPanelLabel">Current world</p>
									<p>{activeWorld.name}</p>
								</div>
								<div>
									<p className="debugPanelLabel">Progress</p>
									<p>
										{campaign.completedWorldIds.length} / {CAMPAIGN_WORLDS.length}{" "}
										worlds complete
									</p>
								</div>
								<div>
									<p className="debugPanelLabel">Run state</p>
									<p>{debugRunStateLabel}</p>
								</div>
							</div>
							<div className="debugPanelSection">
								<p className="debugPanelLabel">Attempt id</p>
								<p>{runState.attemptId || "none"}</p>
							</div>
							<div className="debugPanelSection">
								<p className="debugPanelLabel">Secure flow</p>
								<div className="debugPanelActions">
									<button
										type="button"
										className="debugActionButton"
										onClick={() => void resetCampaign()}
									>
										Reset everything
									</button>
								</div>
								<p className="debugPanelHint">
									Server-attested progression is active, so local shortcut cheats
									are disabled in this mode.
								</p>
							</div>
						</div>
					) : null}
				</section>
			) : null}
			{session.overlayOpen ? (
				<section className="conversationPanel">
					<div className="conversationHeader">
						<div>
							<p className="conversationEyebrow">Live Conversation</p>
							<h2>{activeNpc.displayName}</h2>
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
					<p className="conversationObjective">{activeWorld.objectiveLabel}</p>
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
						{objectiveComplete ? (
							<p className="conversationSuccess">
								Objective complete. The next step of the campaign is unlocked.
							</p>
						) : null}
					</div>
				</section>
			) : null}
			{campaign.pendingTransition ? (
				<section className="campaignOverlay">
					<div className="campaignPanel">
						<p className="conversationEyebrow">Campaign Progress</p>
						<h2>{campaign.pendingTransition.title}</h2>
						<p className="campaignBody">{campaign.pendingTransition.body}</p>
						<div className="campaignDetails">
							<p className="campaignLabel">Next world</p>
							<p>{campaign.pendingTransition.nextWorldName}</p>
							<p className="campaignLabel">Next objective</p>
							<p>{campaign.pendingTransition.nextObjectiveLabel}</p>
						</div>
						<div className="campaignActions">
							<button
								type="button"
								className="tavernButton"
								onClick={continueToNextWorld}
							>
								Continue
							</button>
							<button
								type="button"
								className="tavernSecondaryButton"
								onClick={() => void resetCampaign()}
							>
								Reset run
							</button>
						</div>
					</div>
				</section>
			) : null}
			{campaign.campaignComplete ? (
				<section className="campaignOverlay">
					<div className="campaignPanel">
						<p className="conversationEyebrow">Campaign Complete</p>
						<h2>All worlds completed</h2>
						<p className="campaignBody">
							You ran the full Ledger Trail and found where it was hidden.
						</p>
						{finalElapsedMs ? (
							<div className="leaderboardSummary">
								<p className="campaignLabel">
									{canSubmitScore ? "Official time" : "Completion time"}
								</p>
								<p className="leaderboardTime">{formatElapsedTime(finalElapsedMs)}</p>
							</div>
						) : null}
						<p className="campaignBody">
							{canSubmitScore
								? "This server-attested run is eligible for the secure leaderboard."
								: leaderboardMessage}
						</p>
						{canSubmitScore ? (
							<form
								className="leaderboardForm"
								onSubmit={(event) => void submitLeaderboardScore(event)}
							>
								<label className="campaignLabel" htmlFor="leaderboard-initials">
									Enter your initials
								</label>
								<div className="leaderboardFormRow">
									<input
										id="leaderboard-initials"
										className="leaderboardInput"
										type="text"
										inputMode="text"
										autoComplete="off"
										maxLength={3}
										value={leaderboard.initials}
										onChange={(event) => {
											const nextInitials = sanitizeInitials(event.target.value);
											setLeaderboard((previous) => ({
												...previous,
												initials: nextInitials,
												submitError: "",
											}));
										}}
										placeholder="ABC"
									/>
									<button
										type="submit"
										className="tavernButton"
										disabled={
											leaderboard.submitting ||
											!isValidInitials(leaderboard.initials)
										}
									>
										{leaderboard.submitting ? "Submitting..." : "Submit score"}
									</button>
								</div>
								<p className="conversationHint">
									Duplicate initials are auto-numbered on the leaderboard.
								</p>
								{leaderboard.submitError ? (
									<p className="conversationError">{leaderboard.submitError}</p>
								) : null}
							</form>
						) : null}
						{(runState.submittedAtMs || leaderboard.playerEntry) &&
						(runState.playerRank || leaderboard.playerRank) ? (
							<div className="leaderboardPlayerCard">
								<p className="campaignLabel">Your rank</p>
								<p className="leaderboardPlayerRank">
									#{leaderboard.playerRank ?? runState.playerRank}
								</p>
								<p className="campaignBody">
									{leaderboard.playerEntry?.displayInitials ||
										runState.submittedDisplayInitials}
									{" · "}
									{formatElapsedTime(
										leaderboard.playerEntry?.elapsedMs ?? finalElapsedMs,
									)}
								</p>
							</div>
						) : null}
						<div className="leaderboardBoard">
							<div className="leaderboardBoardHeader">
								<p className="campaignLabel">Global leaderboard</p>
								{leaderboard.loading ? (
									<p className="conversationHint">Loading latest standings...</p>
								) : null}
							</div>
							{leaderboard.error ? (
								<p className="conversationError">{leaderboard.error}</p>
							) : null}
							{leaderboard.entries.length ? (
								<div className="leaderboardList" role="list">
									{leaderboard.entries.map((entry) => {
										const isPlayerEntry =
											entry.id === leaderboard.playerEntry?.id ||
											entry.id === runState.submittedEntryId;

										return (
											<article
												key={entry.id}
												className={`leaderboardRow${isPlayerEntry ? " leaderboardRow--highlight" : ""}`}
												role="listitem"
											>
												<p className="leaderboardRank">#{entry.rank}</p>
												<div className="leaderboardEntryMeta">
													<p className="leaderboardEntryName">
														{entry.displayInitials}
													</p>
													<p className="conversationHint">
														{formatElapsedTime(entry.elapsedMs)}
													</p>
												</div>
											</article>
										);
									})}
								</div>
							) : leaderboard.loading ? null : (
								<p className="conversationHint">
									No ranked runs yet. The first clean clear will set the pace.
								</p>
							)}
						</div>
						<div className="campaignActions">
							<button
								type="button"
								className="tavernButton"
								onClick={() => void resetCampaign()}
							>
								Start over
							</button>
						</div>
					</div>
				</section>
			) : null}
			{loadError ? <p className="tavernError">{loadError}</p> : null}
		</main>
	);
}
