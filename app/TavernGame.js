"use client";

import { useEffect, useRef, useState } from "react";

export default function TavernGame() {
	const containerRef = useRef(null);
	const startButtonRef = useRef(null);
	const infoRef = useRef(null);
	const loadingRef = useRef(null);
	const volumeButtonRef = useRef(null);
	const reticleRef = useRef(null);
	const [loadError, setLoadError] = useState("");

	useEffect(() => {
		let cancelled = false;
		let cleanup = null;

		async function mount() {
			try {
				const { mountTavernScene } = await import(
					/* webpackIgnore: true */ "/tavern-scene-runtime.js"
				);
				if (cancelled || !containerRef.current) return;

				const dispose = await mountTavernScene({
					container: containerRef.current,
					ui: {
						startButton: startButtonRef.current,
						infoElement: infoRef.current,
						loadingElement: loadingRef.current,
						volumeButton: volumeButtonRef.current,
						reticle: reticleRef.current,
					},
				});

				if (cancelled) {
					dispose?.();
					return;
				}

				cleanup = dispose;
			} catch (error) {
				console.error("Failed to mount tavern scene:", error);
				if (!cancelled) {
					setLoadError(
						"Unable to load the tavern scene. Check the console for details.",
					);
				}
			}
		}

		mount();

		return () => {
			cancelled = true;
			cleanup?.();
		};
	}, []);

	return (
		<main className="tavernPage">
			<div ref={containerRef} className="tavernCanvasRoot" />
			<div ref={infoRef} className="tavernInfo">
				<button ref={startButtonRef} className="tavernButton" type="button">
					Click to play
				</button>
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
			<div ref={loadingRef} className="tavernLoading">
				<div className="tavernSpinner" />
				Loading splats...
			</div>
			{loadError ? <p className="tavernError">{loadError}</p> : null}
		</main>
	);
}
