import * as RAPIER from "@dimforge/rapier3d-compat";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import * as THREE from "three";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const GLOBAL_SCALE = 0.7;
const FIXED_TIME_STEP = 1 / 60;
const MAX_SUBSTEPS = 5;
const PLAYER_RADIUS = 0.1 * GLOBAL_SCALE;
const PLAYER_HALF_HEIGHT = 0.5 * GLOBAL_SCALE;
const PLAYER_EYE_HEIGHT = 1.0 * GLOBAL_SCALE;
const PLAYER_JUMP_SPEED = 8.0 * GLOBAL_SCALE;

const CONFIG = {
	GRAVITY: { x: 0, y: -9.81 * GLOBAL_SCALE, z: 0 },
	RAPIER_INIT_TIMEOUT: 10000,
	MOVE_SPEED: 3 * GLOBAL_SCALE,
	ENVIRONMENT_RESTITUTION: 0,
	MUSIC_VOLUME: 0.15,
	ENVIRONMENT: {
		MESH: "/elegant_library_with_fireplace_collider.glb",
		SPLATS: "/elegant_library_with_fireplace_2m.spz",
		SPLAT_SCALE: 3,
	},
	AUDIO_FILES: {
		BACKGROUND_MUSIC: "/Vince_chi_resta.mp3",
	},
	PLAYER_SPAWN: {
		x: 0,
		z: 0,
		rayOriginY: 10,
		rayMaxDistance: 60,
		fallbackCenterY: 1 * GLOBAL_SCALE,
	},
};

function setupMaterialsForLighting(object, brightnessMultiplier = 1) {
	object.traverse((child) => {
		if (!child.isMesh || !child.material) return;

		const materials = Array.isArray(child.material)
			? child.material
			: [child.material];
		const nextMaterials = [];

		for (const material of materials) {
			if (material.emissive) material.emissive.setHex(0x000000);
			if (material.emissiveIntensity !== undefined) {
				material.emissiveIntensity = 0;
			}

			if (material.type === "MeshBasicMaterial") {
				nextMaterials.push(
					new THREE.MeshStandardMaterial({
						color: material.color,
						map: material.map,
						normalMap: material.normalMap,
						roughness: 0.8,
						metalness: 0.1,
					}),
				);
				continue;
			}

			if (material.roughness !== undefined) material.roughness = 0.8;
			if (material.metalness !== undefined) material.metalness = 0.1;

			if (material.color && brightnessMultiplier !== 1) {
				const color = material.color.clone();
				color.multiplyScalar(brightnessMultiplier);
				material.color = color;
			}

			if (material.transparent && material.opacity === 1) {
				material.transparent = false;
			}

			nextMaterials.push(material);
		}

		child.material = Array.isArray(child.material)
			? nextMaterials
			: nextMaterials[0];
	});
}

function disposeSceneGraph(root) {
	root.traverse((child) => {
		if (child.geometry?.dispose) child.geometry.dispose();

		if (!child.material) return;
		const materials = Array.isArray(child.material)
			? child.material
			: [child.material];

		for (const material of materials) {
			for (const key of ["map", "normalMap", "roughnessMap", "metalnessMap"]) {
				if (material[key]?.dispose) material[key].dispose();
			}
			material.dispose?.();
		}
	});
}

async function loadAudioBuffer(audioContext, file) {
	const response = await fetch(file);
	const arrayBuffer = await response.arrayBuffer();
	return audioContext.decodeAudioData(arrayBuffer);
}

export async function mountTavernScene({
	container,
	ui = {},
	npc,
	callbacks = {},
}) {
	if (!container) {
		throw new Error("mountTavernScene requires a container element.");
	}

	const ownerDocument = container.ownerDocument;
	const windowRef = ownerDocument.defaultView ?? window;
	const bodyElement = ownerDocument.body;
	const {
		startButton = null,
		infoElement = null,
		loadingElement = null,
		volumeButton = null,
		reticle = null,
	} = ui;
	const {
		onSceneReadyChange = null,
		onInteractionStateChange = null,
		onInteractionRequested = null,
	} = callbacks;

	let disposed = false;
	let muted = false;
	let animationFrameId = null;
	let environmentCollisionReady = false;
	let physicsAccumulator = 0;
	let previousTime = windowRef.performance.now();
	let hasEnteredRoom = false;
	let conversationActive = false;
	let shouldRestorePointerLock = false;
	let currentInteractionState = false;
	let currentDuckFactor = 1;
	let targetDuckFactor = 1;
	let mobBossLoaded = false;
	let sceneReady = false;

	const cleanupFns = [];

	const addListener = (target, type, listener, options) => {
		target?.addEventListener(type, listener, options);
		if (!target?.removeEventListener) return;
		cleanupFns.push(() => target.removeEventListener(type, listener, options));
	};

	const setMuted = (value) => {
		muted = Boolean(value);
		if (volumeButton) {
			volumeButton.textContent = muted ? "🔇" : "🔊";
		}
	};

	const getViewport = () => ({
		width: container.clientWidth || windowRef.innerWidth,
		height: container.clientHeight || windowRef.innerHeight,
	});

	try {
		const initPromise = RAPIER.init();
		const timeoutPromise = new Promise((_, reject) =>
			windowRef.setTimeout(
				() => reject(new Error("Rapier initialization timeout")),
				CONFIG.RAPIER_INIT_TIMEOUT,
			),
		);

		await Promise.race([initPromise, timeoutPromise]);
	} catch (error) {
		console.error("Failed to initialize Rapier:", error);
	}

	if (disposed) {
		return { dispose() {} };
	}

	const { width, height } = getViewport();
	const scene = new THREE.Scene();
	scene.background = new THREE.Color(0x202020);

	const camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
	camera.rotation.y = Math.PI;

	const renderer = new THREE.WebGLRenderer();
	renderer.setSize(width, height);
	renderer.setPixelRatio(1);
	renderer.outputColorSpace = THREE.SRGBColorSpace;
	renderer.domElement.style.display = "block";
	renderer.domElement.style.width = "100%";
	renderer.domElement.style.height = "100%";
	renderer.domElement.tabIndex = 0;
	container.appendChild(renderer.domElement);

	const sparkRenderer = new SparkRenderer({ renderer });
	sparkRenderer.sortRadial = true;
	scene.add(sparkRenderer);

	scene.add(new THREE.HemisphereLight(0xfff4e6, 0x2a1a0a, 1.0));

	const dirLight = new THREE.DirectionalLight(0xffe6cc, 0.3);
	dirLight.position.set(3, 10, -5);
	scene.add(dirLight);

	const pointLight = new THREE.PointLight(0xffa500, 2.0, 10);
	pointLight.position.set(-3.2, -1, 4.5);
	scene.add(pointLight);

	const world = new RAPIER.World(CONFIG.GRAVITY);
	let playerBody = world.createRigidBody(
		RAPIER.RigidBodyDesc.dynamic()
			.setTranslation(0, 1.2, 0)
			.lockRotations(true)
			.setLinearDamping(4)
			.setCcdEnabled(true),
	);

	world.createCollider(
		RAPIER.ColliderDesc.capsule(PLAYER_HALF_HEIGHT, PLAYER_RADIUS)
			.setFriction(0.8)
			.setRestitution(0),
		playerBody,
	);

	const controls = new PointerLockControls(camera, bodyElement);
	const keyState = {};
	const gltfLoader = new GLTFLoader();
	const fbxLoader = new FBXLoader();
	const animationMixers = {};

	let audioContext = null;
	let musicBuffer = null;
	let musicSource = null;
	let musicGain = null;

	let environment = null;
	let splatMesh = null;
	let splatsLoaded = false;
	let mobBoss = null;
	let mobBossAnchorOffsetY = 1.25;
	const mobBossAnchor = new THREE.Vector3();

	function syncMusicGain() {
		if (!musicGain) return;
		musicGain.gain.value = (muted ? 0 : 1) * CONFIG.MUSIC_VOLUME * currentDuckFactor;
	}

	function syncSceneReadyState() {
		const nextReady =
			Boolean(environmentCollisionReady) && Boolean(splatsLoaded) && Boolean(mobBossLoaded);

		if (sceneReady === nextReady) return;
		sceneReady = nextReady;
		onSceneReadyChange?.(sceneReady);

		if (loadingElement) {
			loadingElement.style.display = sceneReady ? "none" : "block";
		}
	}

	function updateOverlayVisibility() {
		if (reticle) {
			reticle.style.display =
				hasEnteredRoom && !conversationActive ? "block" : "none";
		}

		if (!infoElement) return;
		if (conversationActive) {
			infoElement.style.display = "none";
			return;
		}

		infoElement.style.display = hasEnteredRoom ? "none" : "";
	}

	function setConversationActive(active) {
		const nextValue = Boolean(active);
		if (conversationActive === nextValue) return;

		conversationActive = nextValue;

		if (conversationActive) {
			shouldRestorePointerLock = controls.isLocked;
			if (controls.isLocked) controls.unlock();
		}

		updateOverlayVisibility();
		updateInteractionState(true);
	}

	function setMusicDuckFactor(value) {
		targetDuckFactor = THREE.MathUtils.clamp(value, 0.05, 1);
	}

	function resumePointerLock() {
		if (conversationActive || !hasEnteredRoom || !shouldRestorePointerLock) return;
		shouldRestorePointerLock = false;
	}

	function enterRoom() {
		if (!sceneReady) return;

		hasEnteredRoom = true;
		updateOverlayVisibility();
		updateInteractionState(true);
		startButton?.blur?.();
		renderer.domElement.focus?.();
	}

	function startMusicLoop() {
		if (!audioContext || !musicBuffer || disposed) return;

		if (musicSource) {
			try {
				musicSource.stop();
			} catch {
				// Ignore stop races while recreating the loop.
			}
			musicSource = null;
		}

		musicSource = audioContext.createBufferSource();
		musicSource.buffer = musicBuffer;
		musicSource.loop = true;

		musicGain = audioContext.createGain();
		musicSource.connect(musicGain);
		musicGain.connect(audioContext.destination);
		syncMusicGain();
		musicSource.start(0);
	}

	async function initAudio() {
		if (audioContext || disposed) return;

		audioContext = new (windowRef.AudioContext || windowRef.webkitAudioContext)();
		musicBuffer = await loadAudioBuffer(
			audioContext,
			CONFIG.AUDIO_FILES.BACKGROUND_MUSIC,
		).catch((error) => {
			console.error("Unable to load background music:", error);
			return null;
		});

		if (musicBuffer) startMusicLoop();
	}

	function placePlayerOnSpawn() {
		if (!playerBody) return;

		const { x, z, rayOriginY, rayMaxDistance, fallbackCenterY } =
			CONFIG.PLAYER_SPAWN;
		const ray = new RAPIER.Ray({ x, y: rayOriginY, z }, { x: 0, y: -1, z: 0 });
		const hit = world.castRayAndGetNormal(ray, rayMaxDistance, true);
		let centerY = fallbackCenterY;

		if (hit && hit.toi > 0.05) {
			const floorY = rayOriginY - hit.toi;
			centerY = floorY + PLAYER_HALF_HEIGHT + PLAYER_RADIUS + 0.25;
		}

		playerBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
		playerBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
		playerBody.setTranslation({ x, y: centerY, z }, true);
	}

	function isPlayerGrounded() {
		if (!playerBody) return false;

		const p = playerBody.translation();
		const ray = new RAPIER.Ray(
			{ x: p.x, y: p.y, z: p.z },
			{ x: 0, y: -1, z: 0 },
		);
		const footOffset = PLAYER_HALF_HEIGHT + PLAYER_RADIUS;
		const hit = world.castRayAndGetNormal(ray, footOffset + 0.6, true);
		if (!hit) return false;

		const normalY = hit.normal ? hit.normal.y : 1;
		const nearGround = hit.toi <= footOffset + 0.12 && normalY > 0.3;
		return nearGround && playerBody.linvel().y <= 0.6;
	}

	function updateMovement() {
		if (!hasEnteredRoom || !playerBody || conversationActive) return;

		const forward = new THREE.Vector3();
		camera.getWorldDirection(forward);
		forward.y = 0;
		forward.normalize();

		const right = new THREE.Vector3();
		right.crossVectors(forward, camera.up).normalize();

		const moveDirection = new THREE.Vector3();
		if (keyState.KeyW) moveDirection.add(forward);
		if (keyState.KeyS) moveDirection.sub(forward);
		if (keyState.KeyD) moveDirection.add(right);
		if (keyState.KeyA) moveDirection.sub(right);

		let targetX = 0;
		let targetZ = 0;
		if (moveDirection.lengthSq() > 0) {
			moveDirection.normalize().multiplyScalar(CONFIG.MOVE_SPEED);
			targetX = moveDirection.x;
			targetZ = moveDirection.z;
		}

		const currentVelocity = playerBody.linvel();
		let targetY = currentVelocity.y;
		if (keyState.KeyR) targetY += CONFIG.MOVE_SPEED;
		if (keyState.KeyF) targetY -= CONFIG.MOVE_SPEED;

		playerBody.setLinvel({ x: targetX, y: targetY, z: targetZ }, true);
	}

	function updateMobBossAnchor() {
		if (!mobBoss || typeof mobBoss.getWorldPosition !== "function") return;
		mobBoss.getWorldPosition(mobBossAnchor);
		mobBossAnchor.y += mobBossAnchorOffsetY;
	}

	function updateInteractionState(force = false) {
		updateMobBossAnchor();

		let canInteract = false;
		if (mobBoss && hasEnteredRoom && !conversationActive) {
			const forward = new THREE.Vector3();
			camera.getWorldDirection(forward);
			forward.normalize();

			const toNpc = mobBossAnchor.clone().sub(camera.position);
			const distance = toNpc.length();
			const facing = distance > 0.001 ? forward.dot(toNpc.normalize()) : 0;

			canInteract =
				distance <= npc.interactionRadius && facing >= npc.interactionFacingDot;
		}

		if (!force && currentInteractionState === canInteract) return;

		currentInteractionState = canInteract;
		onInteractionStateChange?.({
			canInteract,
			npcId: npc.id,
			promptText: canInteract ? "Press E to talk" : "",
		});
	}

	const handleStart = () => {
		enterRoom();
	};
	const handleLock = () => {
		updateOverlayVisibility();
		updateInteractionState(true);
	};
	const handleUnlock = () => {
		updateOverlayVisibility();
		updateInteractionState(true);
	};

	startButton?.addEventListener("click", handleStart);
	cleanupFns.push(() => startButton?.removeEventListener("click", handleStart));
	controls.addEventListener("lock", handleLock);
	controls.addEventListener("unlock", handleUnlock);
	cleanupFns.push(() => controls.removeEventListener("lock", handleLock));
	cleanupFns.push(() => controls.removeEventListener("unlock", handleUnlock));

	addListener(volumeButton, "click", () => {
		setMuted(!muted);
		syncMusicGain();
	});
	addListener(renderer.domElement, "click", () => {
		if (hasEnteredRoom && !conversationActive && !controls.isLocked) {
			try {
				controls.lock();
			} catch {
				// Pointer lock is optional for movement; ignore acquisition failures.
			}
		}
	});
	addListener(ownerDocument, "keydown", initAudio, { once: true });
	addListener(ownerDocument, "click", initAudio, { once: true });

	if (loadingElement) loadingElement.style.display = "block";
	onSceneReadyChange?.(false);

	gltfLoader.load(CONFIG.ENVIRONMENT.MESH, (gltf) => {
		if (disposed) return;

		environment = gltf.scene;
		environment.scale.set(-1, -1, 1);
		scene.add(environment);
		environment.updateMatrixWorld(true);

		environment.traverse((child) => {
			if (!child.isMesh || !child.geometry) return;

			const geometry = child.geometry.clone();
			child.updateWorldMatrix(true, false);
			geometry.applyMatrix4(child.matrixWorld);

			const vertices = new Float32Array(geometry.attributes.position.array);
			let indices;

			if (geometry.index) {
				indices = new Uint32Array(geometry.index.array);
			} else {
				const count = geometry.attributes.position.count;
				indices = new Uint32Array(count);
				for (let index = 0; index < count; index += 1) {
					indices[index] = index;
				}
			}

			const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
			world.createCollider(
				RAPIER.ColliderDesc.trimesh(vertices, indices).setRestitution(
					CONFIG.ENVIRONMENT_RESTITUTION,
				),
				body,
			);

			geometry.dispose?.();
		});

		environmentCollisionReady = true;
		placePlayerOnSpawn();
		physicsAccumulator = 0;
		syncSceneReadyState();
	});

	splatMesh = new SplatMesh({
		url: CONFIG.ENVIRONMENT.SPLATS,
		onLoad: () => {
			if (disposed) return;

			splatsLoaded = true;
			if (environment) environment.visible = false;
			scene.add(splatMesh);
			syncSceneReadyState();
		},
	});
	splatMesh.scale.set(
		CONFIG.ENVIRONMENT.SPLAT_SCALE,
		-CONFIG.ENVIRONMENT.SPLAT_SCALE,
		CONFIG.ENVIRONMENT.SPLAT_SCALE,
	);

	fbxLoader.load(npc.modelKey, (fbx) => {
		if (disposed) return;

		mobBoss = fbx;
		mobBoss.scale.set(...npc.scale);
		mobBoss.position.set(...npc.position);
		mobBoss.rotation.y = npc.rotation;
		scene.add(mobBoss);
		setupMaterialsForLighting(mobBoss, 2);
		mobBossLoaded = true;

		if (fbx.animations?.length) {
			animationMixers.mobBoss = new THREE.AnimationMixer(mobBoss);
			for (const clip of fbx.animations) {
				animationMixers.mobBoss.clipAction(clip).play();
			}
		}

		const box = new THREE.Box3().setFromObject(mobBoss);
		const size = box.getSize(new THREE.Vector3());
		mobBossAnchorOffsetY = Math.max(size.y * 0.55, 0.9);
		syncSceneReadyState();
		updateInteractionState(true);
	});

	const handleKeyDown = (event) => {
		keyState[event.code] = true;

		if (event.code === "KeyE") {
			if (currentInteractionState && !conversationActive) {
				event.preventDefault();
				onInteractionRequested?.({ npcId: npc.id });
			}
			return;
		}

		if (event.code === "Space" && playerBody && isPlayerGrounded()) {
			const velocity = playerBody.linvel();
			playerBody.setLinvel(
				{ x: velocity.x, y: PLAYER_JUMP_SPEED, z: velocity.z },
				true,
			);
		}
	};

	const handleKeyUp = (event) => {
		keyState[event.code] = false;
	};

	addListener(windowRef, "keydown", handleKeyDown);
	addListener(windowRef, "keyup", handleKeyUp);

	function animate(currentTime) {
		if (disposed) return;

		animationFrameId = windowRef.requestAnimationFrame(animate);

		const frameTime = Math.min((currentTime - previousTime) / 1000, 0.1);
		previousTime = currentTime;

		updateMovement();

		currentDuckFactor = THREE.MathUtils.lerp(
			currentDuckFactor,
			targetDuckFactor,
			1 - Math.exp(-frameTime * 6),
		);
		syncMusicGain();

		physicsAccumulator += frameTime;
		const steps = Math.min(
			Math.floor(physicsAccumulator / FIXED_TIME_STEP),
			MAX_SUBSTEPS,
		);

		if (!environmentCollisionReady) physicsAccumulator = 0;

		for (let step = 0; step < steps && environmentCollisionReady; step += 1) {
			world.step();
			physicsAccumulator -= FIXED_TIME_STEP;
		}

		if (playerBody) {
			const p = playerBody.translation();
			const feetY = p.y - (PLAYER_HALF_HEIGHT + PLAYER_RADIUS);
			camera.position.set(p.x, feetY + PLAYER_EYE_HEIGHT, p.z);
		}

		for (const mixer of Object.values(animationMixers)) {
			mixer?.update(frameTime);
		}

		updateInteractionState();
		sparkRenderer.update?.({ scene });
		renderer.render(scene, camera);
	}

	const handleResize = () => {
		const nextViewport = getViewport();
		camera.aspect = nextViewport.width / nextViewport.height;
		camera.updateProjectionMatrix();
		renderer.setSize(nextViewport.width, nextViewport.height);
	};

	addListener(windowRef, "resize", handleResize);
	updateOverlayVisibility();
	updateInteractionState(true);
	animate(previousTime);

	return {
		setConversationActive,
		setMusicDuckFactor,
		resumePointerLock,
		dispose() {
			disposed = true;

			if (animationFrameId != null) {
				windowRef.cancelAnimationFrame(animationFrameId);
			}

			for (const cleanup of cleanupFns.splice(0)) cleanup();

			if (musicSource) {
				try {
					musicSource.stop();
				} catch {
					// Ignore stop races during teardown.
				}
			}
			audioContext?.close?.().catch?.(() => {});

			if (loadingElement) loadingElement.style.display = "none";
			if (reticle) reticle.style.display = "none";
			if (infoElement) infoElement.style.display = "";

			controls.unlock();
			controls.disconnect?.();
			controls.dispose?.();

			splatMesh?.dispose?.();
			sparkRenderer.dispose?.();
			renderer.dispose();
			disposeSceneGraph(scene);

			if (renderer.domElement.parentNode === container) {
				container.removeChild(renderer.domElement);
			}

			playerBody = null;
		},
	};
}
