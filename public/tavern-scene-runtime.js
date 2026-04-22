import * as RAPIER from "@dimforge/rapier3d-compat";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import * as THREE from "three";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const GLOBAL_SCALE = 0.7;

const CONFIG = {
	GRAVITY: { x: 0, y: -9.81 * GLOBAL_SCALE, z: 0 },
	RAPIER_INIT_TIMEOUT: 10000,
	MOVE_SPEED: 3 * GLOBAL_SCALE,
	PROJECTILE_SPEED: 15 * GLOBAL_SCALE,
	VOICE_COOLDOWN: 1.0,
	MUSIC_VOLUME: 0.15,
	VOICE_VOLUME: 0.4,
	PROJECTILE_RADIUS: 0.2 * GLOBAL_SCALE,
	PROJECTILE_RESTITUTION: 0.9,
	ENVIRONMENT_RESTITUTION: 0.0,
	BONE_COLLIDER_RADIUS: 0.3,
	BOUNCE_DETECTION_THRESHOLD: 2.0,
	CHARACTER_HIT_DISTANCE: 0.8,
	VELOCITY_PITCH_RANGE: { min: 0.9, max: 1.1 },
	VOLUME_DISTANCE_MAX: 10,
	ENVIRONMENT: {
		MESH: "/elegant_library_with_fireplace_collider.glb",
		SPLATS: "/elegant_library_with_fireplace_2m.spz",
		SPLAT_SCALE: 3,
	},
	CHARACTERS: {
		ORC: {
			MODEL: "/orc.glb",
			POSITION: [-2, -5, 2],
			ROTATION: Math.PI / 2,
			SCALE: [1, 1, 1],
		},
		BARTENDER: {
			MODEL: "/mob_boss_sitting.fbx",
			POSITION: [0.69, -0.7, 2.75],
			ROTATION: -Math.PI / 1.5,
			SCALE: [0.005, 0.005, 0.005],
		},
	},
	AUDIO_FILES: {
		BOUNCE: "/bounce.mp3",
		BACKGROUND_MUSIC: "/kitchen_music.mp3",
		ORC_VOICES: [
			"/lines/rocks.mp3",
			"/lines/mushroom.mp3",
			"/lines/watch.mp3",
			"/lines/vex.mp3",
		],
		BARTENDER_VOICES: [
			"/lines/working.mp3",
			"/lines/juggler.mp3",
			"/lines/drink.mp3",
		],
	},
	JENGA: {
		ENABLED: true,
		SCALE: 0.2,
		LAYERS: 16,
		BRICK: { LEN: 3.0, WID: 1.0, HT: 0.6, GAP: 0.001 },
		ORIGIN: { x: -0.896, y: -0.063 - 0.7 + 0.001, z: 6.385 },
	},
	GRAB: {
		MAX_DISTANCE: 3.0,
		HOLD_DISTANCE: 1.2,
		HIGHLIGHT_EMISSIVE: 0xffff00,
	},
	PLAYER_SPAWN: {
		x: 0,
		z: 0,
		rayOriginY: 10,
		rayMaxDistance: 60,
		fallbackCenterY: 1 * GLOBAL_SCALE,
	},
};

const FIXED_TIME_STEP = 1 / 60;
const MAX_SUBSTEPS = 5;
const PLAYER_RADIUS = 0.1 * GLOBAL_SCALE;
const PLAYER_HALF_HEIGHT = 0.5 * GLOBAL_SCALE;
const PLAYER_EYE_HEIGHT = 1.0 * GLOBAL_SCALE;
const PLAYER_JUMP_SPEED = 8.0 * GLOBAL_SCALE;
const PROJECTILE_SPAWN_OFFSET =
	PLAYER_RADIUS + CONFIG.PROJECTILE_RADIUS + 0.15 * GLOBAL_SCALE;

function setupMaterialsForLighting(object, brightnessMultiplier = 1.0) {
	object.traverse((child) => {
		if (child.isMesh && child.material) {
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

				if (material.color && brightnessMultiplier !== 1.0) {
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
		}
	});
}

function createBoneColliders(character, world) {
	const boneColliders = [];

	character.traverse((child) => {
		if (!child?.isBone || typeof child.getWorldPosition !== "function") return;

		const bonePos = new THREE.Vector3();
		child.getWorldPosition(bonePos);

		const colliderDesc = RAPIER.ColliderDesc.ball(CONFIG.BONE_COLLIDER_RADIUS);
		const bodyDesc =
			RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(
				bonePos.x,
				bonePos.y,
				bonePos.z,
			);

		const body = world.createRigidBody(bodyDesc);
		world.createCollider(colliderDesc, body);
		boneColliders.push({ bone: child, body });
	});

	return boneColliders;
}

async function loadAudioFiles(audioContext, fileList) {
	try {
		return await Promise.all(
			fileList.map((file) =>
				fetch(file)
					.then((response) => response.arrayBuffer())
					.then((buffer) => audioContext.decodeAudioData(buffer)),
			),
		);
	} catch (error) {
		console.error("Error loading audio files:", error);
		return [];
	}
}

function playAudio(audioContext, buffer, muted, volume = 1.0, playbackRate = 1.0) {
	if (!audioContext || !buffer) return null;

	const source = audioContext.createBufferSource();
	const gainNode = audioContext.createGain();

	source.buffer = buffer;
	source.connect(gainNode);
	gainNode.connect(audioContext.destination);
	gainNode.gain.value = (muted ? 0 : 1) * volume;
	source.playbackRate.value = playbackRate;
	source.start(0);

	return source;
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

export async function mountTavernScene({ container, ui = {} }) {
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

	let disposed = false;
	let muted = false;
	let animationFrameId = null;
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
		console.log("✓ Rapier physics initialized");
	} catch (error) {
		console.error("Failed to initialize Rapier:", error);
	}

	if (disposed) return () => {};

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

	container.appendChild(renderer.domElement);

	const sparkRenderer = new SparkRenderer({ renderer });
	sparkRenderer.sortRadial = true;
	scene.add(sparkRenderer);

	const hemiLight = new THREE.HemisphereLight(0xfff4e6, 0x2a1a0a, 1.0);
	hemiLight.position.set(0, 20, 0);
	scene.add(hemiLight);

	const dirLight = new THREE.DirectionalLight(0xffe6cc, 0.3);
	dirLight.position.set(3, 10, -5);
	scene.add(dirLight);

	const pointLight = new THREE.PointLight(0xffa500, 2.0, 10);
	pointLight.position.set(-3.2, -1, 4.5);
	scene.add(pointLight);

	const world = new RAPIER.World(CONFIG.GRAVITY);
	const jengaBlocks = [];
	const bodyToMesh = new Map();
	const projectileBodies = new Set();
	const meshToBody = new Map();
	const grabbableMeshes = [];

	function buildJengaTower(cfg) {
		const scale = cfg.SCALE;
		const brickLen = cfg.BRICK.LEN * scale;
		const brickWid = cfg.BRICK.WID * scale;
		const brickHt = cfg.BRICK.HT * scale;
		const gap = cfg.BRICK.GAP * scale;
		const base = cfg.ORIGIN;

		for (let layer = 0; layer < cfg.LAYERS; layer += 1) {
			const alongZ = layer % 2 === 0;
			const sizeX = alongZ ? brickWid : brickLen;
			const sizeZ = alongZ ? brickLen : brickWid;
			const halfX = sizeX / 2;
			const halfY = brickHt / 2;
			const halfZ = sizeZ / 2;
			const y = base.y + halfY + layer * (brickHt + gap);
			const pitch = (alongZ ? sizeX : sizeZ) + gap;

			for (let i = -1; i <= 1; i += 1) {
				const offset = i * pitch;
				const x = alongZ ? base.x + offset : base.x;
				const z = alongZ ? base.z : base.z + offset;

				const geom = new THREE.BoxGeometry(sizeX, brickHt, sizeZ);
				const mat = new THREE.MeshStandardMaterial({
					color: 0x0f0fff,
					metalness: 0.1,
					roughness: 0.8,
				});
				const mesh = new THREE.Mesh(geom, mat);
				mesh.position.set(x, y, z);
				scene.add(mesh);

				const body = world.createRigidBody(
					RAPIER.RigidBodyDesc.dynamic()
						.setTranslation(x, y, z)
						.setCanSleep(true)
						.setLinearDamping(0.1)
						.setAngularDamping(0.2),
				);

				world.createCollider(
					RAPIER.ColliderDesc.cuboid(halfX, halfY, halfZ)
						.setFriction(0.8)
						.setRestitution(0.05),
					body,
				);

				jengaBlocks.push({ mesh, body });
				bodyToMesh.set(body.handle, mesh);
				meshToBody.set(mesh, body);
				grabbableMeshes.push(mesh);
			}
		}
	}

	if (CONFIG.JENGA.ENABLED) buildJengaTower(CONFIG.JENGA);

	let envCollisionReady = false;
	let playerBody = world.createRigidBody(
		RAPIER.RigidBodyDesc.dynamic()
			.setTranslation(0, 1.2, 0)
			.lockRotations(true)
			.setLinearDamping(4.0)
			.setCcdEnabled(true),
	);

	world.createCollider(
		RAPIER.ColliderDesc.capsule(PLAYER_HALF_HEIGHT, PLAYER_RADIUS)
			.setFriction(0.8)
			.setRestitution(0.0),
		playerBody,
	);

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

	const controls = new PointerLockControls(camera, bodyElement);
	const handleStart = () => controls.lock();
	const handleLock = () => {
		if (infoElement) infoElement.style.display = "none";
		if (reticle) reticle.style.display = "block";
	};
	const handleUnlock = () => {
		if (infoElement) infoElement.style.display = "";
		if (reticle) reticle.style.display = "none";
	};

	startButton?.addEventListener("click", handleStart);
	cleanupFns.push(() => startButton?.removeEventListener("click", handleStart));
	controls.addEventListener("lock", handleLock);
	controls.addEventListener("unlock", handleUnlock);
	cleanupFns.push(() => controls.removeEventListener("lock", handleLock));
	cleanupFns.push(() => controls.removeEventListener("unlock", handleUnlock));

	let audioContext = null;
	const audioBuffers = {};
	const voiceCooldowns = { orc: 0, bartender: 0 };
	let musicSource = null;
	let musicGain = null;

	function startBackgroundMusic() {
		if (!audioContext || !audioBuffers.backgroundMusic || disposed) return;

		const playMusic = () => {
			if (disposed || !audioContext || !audioBuffers.backgroundMusic) return;

			const source = audioContext.createBufferSource();
			source.buffer = audioBuffers.backgroundMusic;

			musicGain = audioContext.createGain();
			source.connect(musicGain);
			musicGain.connect(audioContext.destination);
			musicGain.gain.value = muted ? 0 : CONFIG.MUSIC_VOLUME;
			source.start(0);
			source.onended = playMusic;
			musicSource = source;
		};

		playMusic();
	}

	function initAudio() {
		if (audioContext || disposed) return;

		audioContext = new (windowRef.AudioContext || windowRef.webkitAudioContext)();

		Promise.all([
			fetch(CONFIG.AUDIO_FILES.BOUNCE)
				.then((response) => response.arrayBuffer())
				.then((buffer) => audioContext.decodeAudioData(buffer))
				.then((buffer) => {
					audioBuffers.bounce = buffer;
				}),
			loadAudioFiles(audioContext, CONFIG.AUDIO_FILES.ORC_VOICES).then(
				(buffers) => {
					audioBuffers.orcVoices = buffers;
				},
			),
			loadAudioFiles(audioContext, CONFIG.AUDIO_FILES.BARTENDER_VOICES).then(
				(buffers) => {
					audioBuffers.bartenderVoices = buffers;
				},
			),
			fetch(CONFIG.AUDIO_FILES.BACKGROUND_MUSIC)
				.then((response) => response.arrayBuffer())
				.then((buffer) => audioContext.decodeAudioData(buffer))
				.then((buffer) => {
					audioBuffers.backgroundMusic = buffer;
					startBackgroundMusic();
				}),
		])
			.then(() => {
				if (!disposed) console.log("✓ Audio system initialized");
			})
			.catch((error) => {
				console.error("Audio loading error:", error);
			});
	}

	function playVoiceLine(character) {
		if (voiceCooldowns[character] > 0) return;

		const voiceBuffers = audioBuffers[`${character}Voices`];
		if (!voiceBuffers?.length) return;

		const randomBuffer =
			voiceBuffers[Math.floor(Math.random() * voiceBuffers.length)];
		playAudio(audioContext, randomBuffer, muted, CONFIG.VOICE_VOLUME);
		voiceCooldowns[character] = CONFIG.VOICE_COOLDOWN;
	}

	function playBounceSound(position, velocity) {
		if (!audioBuffers.bounce) return;

		const distance = camera.position.distanceTo(position);
		let volume = Math.max(0.1, 1.0 * (1 - distance / CONFIG.VOLUME_DISTANCE_MAX));
		let pitch = 1.0;

		if (velocity) {
			const speed = velocity.length();
			const normalizedSpeed = Math.min(speed / 20, 1.0);
			volume *= 0.3 + normalizedSpeed * 0.7;
			pitch =
				CONFIG.VELOCITY_PITCH_RANGE.min +
				normalizedSpeed *
					(CONFIG.VELOCITY_PITCH_RANGE.max -
						CONFIG.VELOCITY_PITCH_RANGE.min);
			pitch *= 0.97 + Math.random() * 0.06;
		}

		playAudio(audioContext, audioBuffers.bounce, muted, volume, pitch);
	}

	addListener(ownerDocument, "click", initAudio, { once: true });
	addListener(ownerDocument, "keydown", initAudio, { once: true });

	const handleVolumeToggle = () => {
		setMuted(!muted);
		if (musicGain) {
			musicGain.gain.value = muted ? 0 : CONFIG.MUSIC_VOLUME;
		}
	};
	volumeButton?.addEventListener("click", handleVolumeToggle);
	cleanupFns.push(() =>
		volumeButton?.removeEventListener("click", handleVolumeToggle),
	);
	setMuted(false);

	let environment = null;
	let splatMesh = null;
	let splatsLoaded = false;
	const envDebugMaterial = new THREE.MeshNormalMaterial();
	const originalEnvMaterials = new Map();

	if (loadingElement) loadingElement.style.display = "block";

	const gltfLoader = new GLTFLoader();
	gltfLoader.load(CONFIG.ENVIRONMENT.MESH, (gltf) => {
		if (disposed) return;

		environment = gltf.scene;
		environment.scale.set(-1, -1, 1);
		scene.add(environment);

		environment.traverse((child) => {
			if (!child.isMesh) return;

			const geometry = child.geometry.clone();
			child.updateWorldMatrix(true, false);
			geometry.applyMatrix4(child.matrixWorld);

			const vertices = new Float32Array(geometry.attributes.position.array);
			const indices = geometry.index
				? new Uint32Array(geometry.index.array)
				: new Uint32Array(geometry.attributes.position.count);

			if (!geometry.index) {
				for (let i = 0; i < geometry.attributes.position.count; i += 1) {
					indices[i] = i;
				}
			}

			const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
			world.createCollider(
				RAPIER.ColliderDesc.trimesh(vertices, indices).setRestitution(
					CONFIG.ENVIRONMENT_RESTITUTION,
				),
				body,
			);
		});

		envCollisionReady = true;
		placePlayerOnSpawn();
		physicsAccumulator = 0;
		console.log("✓ Environment collision mesh loaded");
	});

	splatMesh = new SplatMesh({
		url: CONFIG.ENVIRONMENT.SPLATS,
		onLoad: () => {
			if (disposed) return;

			splatsLoaded = true;
			if (environment) environment.visible = false;
			scene.add(splatMesh);
			if (loadingElement) loadingElement.style.display = "none";
			console.log(`✓ Gaussian splats loaded (${splatMesh.numSplats} splats)`);
		},
	});

	splatMesh.scale.set(
		CONFIG.ENVIRONMENT.SPLAT_SCALE,
		-CONFIG.ENVIRONMENT.SPLAT_SCALE,
		CONFIG.ENVIRONMENT.SPLAT_SCALE,
	);

	const characters = {};
	const animationMixers = {};
	const boneColliders = {};

	gltfLoader.load(CONFIG.CHARACTERS.ORC.MODEL, (gltf) => {
		if (disposed) return;

		const orc = gltf.scene;
		const config = CONFIG.CHARACTERS.ORC;

		orc.rotation.y = config.ROTATION;
		orc.scale.set(...config.SCALE);
		orc.position.set(...config.POSITION);
		scene.add(orc);
		setupMaterialsForLighting(orc);

		if (gltf.animations?.length) {
			animationMixers.orc = new THREE.AnimationMixer(orc);
			for (const clip of gltf.animations) {
				animationMixers.orc.clipAction(clip).play();
			}
		}

		boneColliders.orc = createBoneColliders(orc, world);
		characters.orc = orc;
		console.log("✓ Orc character loaded");
	});

	const fbxLoader = new FBXLoader();
	fbxLoader.load(CONFIG.CHARACTERS.BARTENDER.MODEL, (fbx) => {
		if (disposed) return;

		const bartender = fbx;
		const config = CONFIG.CHARACTERS.BARTENDER;

		bartender.scale.set(...config.SCALE);
		bartender.position.set(...config.POSITION);
		bartender.rotation.y = config.ROTATION;
		scene.add(bartender);
		setupMaterialsForLighting(bartender, 2.0);

		if (fbx.animations?.length) {
			animationMixers.bartender = new THREE.AnimationMixer(bartender);
			for (const clip of fbx.animations) {
				animationMixers.bartender.clipAction(clip).play();
			}
		}

		boneColliders.bartender = createBoneColliders(bartender, world);
		characters.bartender = bartender;
		console.log("✓ Bartender character loaded");
	});

	const keyState = {};
	let debugMode = false;
	const debugVisuals = { orc: [], bartender: [] };
	let hover = { body: null, mesh: null, savedEmissive: null };
	let grabbed = { body: null, mesh: null };

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

		const normalY = hit.normal ? hit.normal.y : 1.0;
		const nearGround = hit.toi <= footOffset + 0.12 && normalY > 0.3;
		return nearGround && playerBody.linvel().y <= 0.6;
	}

	function toggleDebugMode() {
		if (!environment || !splatMesh || !splatsLoaded) return;

		if (debugMode) {
			environment.visible = true;
			scene.remove(splatMesh);

			environment.traverse((child) => {
				if (!child.isMesh) return;
				if (!originalEnvMaterials.has(child.uuid)) {
					originalEnvMaterials.set(child.uuid, child.material);
				}
				child.material = envDebugMaterial;
			});

			for (const [index, character] of ["orc", "bartender"].entries()) {
				if (!boneColliders[character] || debugVisuals[character].length > 0) {
					continue;
				}

				const color = index === 0 ? 0xff00ff : 0x00ffff;
				for (const { bone } of boneColliders[character]) {
					if (!bone || typeof bone.getWorldPosition !== "function") continue;

					const pos = new THREE.Vector3();
					bone.getWorldPosition(pos);

					const sphere = new THREE.Mesh(
						new THREE.SphereGeometry(
							CONFIG.BONE_COLLIDER_RADIUS,
							16,
							16,
						),
						new THREE.MeshBasicMaterial({ color, wireframe: true }),
					);
					sphere.position.copy(pos);
					scene.add(sphere);
					debugVisuals[character].push({ sphere, bone });
				}
			}

			return;
		}

		environment.visible = false;
		scene.add(splatMesh);

		environment.traverse((child) => {
			if (child.isMesh && originalEnvMaterials.has(child.uuid)) {
				child.material = originalEnvMaterials.get(child.uuid);
			}
		});

		for (const character of ["orc", "bartender"]) {
			for (const { sphere } of debugVisuals[character]) {
				scene.remove(sphere);
			}
			debugVisuals[character] = [];
		}
	}

	function adjustVelocityForWalls(desiredVel) {
		const adjusted = desiredVel.clone();
		if (adjusted.lengthSq() === 0) return adjusted;

		const p = playerBody.translation();
		const horiz = new THREE.Vector3(adjusted.x, 0, adjusted.z);
		if (horiz.lengthSq() === 0) return adjusted;

		horiz.normalize();
		const hit = world.castRayAndGetNormal(
			new RAPIER.Ray({ x: p.x, y: p.y, z: p.z }, { x: horiz.x, y: 0, z: horiz.z }),
			PLAYER_RADIUS + 0.1,
			true,
		);
		const normal = hit?.normal;

		if (normal && hit.toi > 0.02) {
			const surface = new THREE.Vector3(normal.x, normal.y, normal.z);
			surface.y = 0;

			if (surface.lengthSq() > 0.0001) {
				surface.normalize();
				const intoWall = adjusted.dot(surface);
				if (intoWall > 0) adjusted.addScaledVector(surface, -intoWall);
			}
		}

		return adjusted;
	}

	function updateMovement() {
		if (!controls.isLocked || !playerBody) return;

		const forward = new THREE.Vector3();
		camera.getWorldDirection(forward);
		forward.y = 0;
		forward.normalize();

		const right = new THREE.Vector3();
		right.crossVectors(forward, camera.up).normalize();

		const moveDir = new THREE.Vector3();
		if (keyState.KeyW) moveDir.add(forward);
		if (keyState.KeyS) moveDir.sub(forward);
		if (keyState.KeyD) moveDir.add(right);
		if (keyState.KeyA) moveDir.sub(right);

		let targetX = 0;
		let targetZ = 0;
		if (moveDir.lengthSq() > 0) {
			moveDir.normalize().multiplyScalar(CONFIG.MOVE_SPEED);
			const adjusted = adjustVelocityForWalls(moveDir);
			targetX = adjusted.x;
			targetZ = adjusted.z;
		}

		const currentVelocity = playerBody.linvel();
		let targetY = currentVelocity.y;
		if (keyState.KeyR) targetY += CONFIG.MOVE_SPEED;
		if (keyState.KeyF) targetY -= CONFIG.MOVE_SPEED;

		playerBody.setLinvel({ x: targetX, y: targetY, z: targetZ }, true);
	}

	const projectiles = [];

	function shootProjectile() {
		const mesh = new THREE.Mesh(
			new THREE.SphereGeometry(CONFIG.PROJECTILE_RADIUS, 16, 16),
			new THREE.MeshStandardMaterial({ color: 0xff4444 }),
		);

		const forward = new THREE.Vector3();
		camera.getWorldDirection(forward);
		forward.normalize();

		const origin = camera.position
			.clone()
			.addScaledVector(forward, PROJECTILE_SPAWN_OFFSET);
		mesh.position.copy(origin);
		scene.add(mesh);

		const body = world.createRigidBody(
			RAPIER.RigidBodyDesc.dynamic()
				.setTranslation(origin.x, origin.y, origin.z)
				.setCcdEnabled(true),
		);
		world.createCollider(
			RAPIER.ColliderDesc.ball(CONFIG.PROJECTILE_RADIUS).setRestitution(
				CONFIG.PROJECTILE_RESTITUTION,
			),
			body,
		);

		const velocity = forward.multiplyScalar(CONFIG.PROJECTILE_SPEED);
		body.setLinvel(velocity, true);

		projectiles.push({ mesh, body, lastVelocity: velocity.clone() });
		bodyToMesh.set(body.handle, mesh);
		projectileBodies.add(body.handle);
	}

	const handleKeyDown = (event) => {
		keyState[event.code] = true;

		if (event.code === "KeyM") {
			debugMode = !debugMode;
			toggleDebugMode();
		}

		if (event.code === "Space" && playerBody && isPlayerGrounded()) {
			const velocity = playerBody.linvel();
			playerBody.setLinvel(
				{ x: velocity.x, y: PLAYER_JUMP_SPEED, z: velocity.z },
				true,
			);
		}

		if (event.code === "KeyP" && playerBody) {
			const p = playerBody.translation();
			const forward = new THREE.Vector3();
			camera.getWorldDirection(forward);
			forward.normalize();
			const yaw = (Math.atan2(forward.x, forward.z) * 180) / Math.PI;
			const pitch =
				(Math.asin(THREE.MathUtils.clamp(forward.y, -1, 1)) * 180) / Math.PI;
			const rot = playerBody.rotation?.();
			const quat = rot
				? `quat=(${rot.x.toFixed(3)}, ${rot.y.toFixed(3)}, ${rot.z.toFixed(
						3,
				  )}, ${rot.w.toFixed(3)})`
				: "";

			console.log(
				`[Player] pos=(${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(
					3,
				)}) yaw=${yaw.toFixed(1)}° pitch=${pitch.toFixed(1)}° ${quat}`,
			);
		}
	};

	const handleKeyUp = (event) => {
		keyState[event.code] = false;
	};

	const handleClick = () => {
		if (!controls.isLocked) return;

		if (grabbed.body) {
			grabbed = { body: null, mesh: null };
			return;
		}

		if (hover.body && hover.mesh) {
			grabbed = { body: hover.body, mesh: hover.mesh };
			return;
		}

		shootProjectile();
	};

	addListener(windowRef, "keydown", handleKeyDown);
	addListener(windowRef, "keyup", handleKeyUp);
	addListener(windowRef, "click", handleClick);

	let previousTime = windowRef.performance.now();
	let physicsAccumulator = 0;

	function updateHover() {
		if (hover.mesh && hover.savedEmissive != null) {
			const material = hover.mesh.material;
			if (material?.emissive) material.emissive.setHex(hover.savedEmissive);
		}

		hover = { body: null, mesh: null, savedEmissive: null };

		const raycaster = new THREE.Raycaster();
		raycaster.far = CONFIG.GRAB.MAX_DISTANCE;
		raycaster.setFromCamera({ x: 0, y: 0 }, camera);
		const hit = raycaster
			.intersectObjects(grabbableMeshes, false)
			.find((candidate) => candidate.distance <= CONFIG.GRAB.MAX_DISTANCE);

		if (!hit) return;

		const mesh = hit.object;
		const material = mesh.material;
		if (!material?.emissive) return;

		hover = {
			body: meshToBody.get(mesh),
			mesh,
			savedEmissive: material.emissive.getHex(),
		};
		material.emissive.setHex(CONFIG.GRAB.HIGHLIGHT_EMISSIVE);
	}

	function animate(currentTime) {
		if (disposed) return;

		animationFrameId = windowRef.requestAnimationFrame(animate);
		const frameTime = Math.min((currentTime - previousTime) / 1000, 0.1);
		previousTime = currentTime;

		updateMovement();

		for (const key of Object.keys(voiceCooldowns)) {
			if (voiceCooldowns[key] > 0) voiceCooldowns[key] -= frameTime;
		}

		physicsAccumulator += frameTime;
		const steps = Math.min(
			Math.floor(physicsAccumulator / FIXED_TIME_STEP),
			MAX_SUBSTEPS,
		);

		if (!envCollisionReady) physicsAccumulator = 0;

		for (let step = 0; step < steps && envCollisionReady; step += 1) {
			world.step();

			for (const projectile of projectiles) {
				const pos = projectile.body.translation();
				const rot = projectile.body.rotation();

				projectile.mesh.position.set(pos.x, pos.y, pos.z);
				projectile.mesh.quaternion.set(rot.x, rot.y, rot.z, rot.w);

				const currentVelocity = new THREE.Vector3(
					projectile.body.linvel().x,
					projectile.body.linvel().y,
					projectile.body.linvel().z,
				);
				const velocityChange = currentVelocity
					.clone()
					.sub(projectile.lastVelocity);

				if (velocityChange.length() > CONFIG.BOUNCE_DETECTION_THRESHOLD) {
					const position = new THREE.Vector3(pos.x, pos.y, pos.z);
					playBounceSound(position, currentVelocity);

					for (const character of ["orc", "bartender"]) {
						if (!boneColliders[character]) continue;

						const hit = boneColliders[character].some(({ bone }) => {
							if (!bone || typeof bone.getWorldPosition !== "function") {
								return false;
							}

							const bonePos = new THREE.Vector3();
							bone.getWorldPosition(bonePos);
							return (
								position.distanceTo(bonePos) < CONFIG.CHARACTER_HIT_DISTANCE
							);
						});

						if (hit) playVoiceLine(character);
					}
				}

				projectile.lastVelocity.copy(currentVelocity);
			}

			for (const block of jengaBlocks) {
				const pos = block.body.translation();
				const rot = block.body.rotation();
				block.mesh.position.set(pos.x, pos.y, pos.z);
				block.mesh.quaternion.set(rot.x, rot.y, rot.z, rot.w);
			}

			if (grabbed.body) {
				const forward = new THREE.Vector3();
				camera.getWorldDirection(forward);
				forward.normalize();

				const holdPos = camera.position
					.clone()
					.addScaledVector(forward, CONFIG.GRAB.HOLD_DISTANCE);

				grabbed.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
				grabbed.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
				grabbed.body.setTranslation(
					{ x: holdPos.x, y: holdPos.y, z: holdPos.z },
					true,
				);

				const yawForward = new THREE.Vector3(forward.x, 0, forward.z);
				if (yawForward.lengthSq() < 1e-6) yawForward.set(0, 0, 1);
				yawForward.normalize();

				const up = new THREE.Vector3(0, 1, 0);
				const right = new THREE.Vector3()
					.crossVectors(up, yawForward)
					.normalize();
				const trueUp = new THREE.Vector3()
					.crossVectors(yawForward, right)
					.normalize();
				const basis = new THREE.Matrix4().makeBasis(right, trueUp, yawForward);
				const rotation = new THREE.Quaternion().setFromRotationMatrix(basis);
				grabbed.body.setRotation(
					{
						x: rotation.x,
						y: rotation.y,
						z: rotation.z,
						w: rotation.w,
					},
					true,
				);
			}

			physicsAccumulator -= FIXED_TIME_STEP;
		}

		if (playerBody) {
			const p = playerBody.translation();
			const feetY = p.y - (PLAYER_HALF_HEIGHT + PLAYER_RADIUS);
			camera.position.set(p.x, feetY + PLAYER_EYE_HEIGHT, p.z);
		}

		sparkRenderer.update?.({ scene });
		updateHover();

		for (const mixer of Object.values(animationMixers)) {
			mixer?.update(frameTime);
		}

		for (const colliders of Object.values(boneColliders)) {
			for (const { bone, body } of colliders) {
				if (
					!bone ||
					typeof bone.getWorldPosition !== "function" ||
					!body
				) {
					continue;
				}

				const pos = new THREE.Vector3();
				bone.getWorldPosition(pos);
				body.setTranslation({ x: pos.x, y: pos.y, z: pos.z }, true);
			}
		}

		if (debugMode) {
			for (const character of ["orc", "bartender"]) {
				for (const { sphere, bone } of debugVisuals[character]) {
					if (
						!bone ||
						typeof bone.getWorldPosition !== "function" ||
						!sphere
					) {
						continue;
					}

					bone.getWorldPosition(sphere.position);
				}
			}
		}

		renderer.render(scene, camera);
	}

	const handleResize = () => {
		const nextViewport = getViewport();
		camera.aspect = nextViewport.width / nextViewport.height;
		camera.updateProjectionMatrix();
		renderer.setSize(nextViewport.width, nextViewport.height);
	};

	addListener(windowRef, "resize", handleResize);
	animate(previousTime);
	console.log("Tavern demo initialized successfully.");

	return () => {
		disposed = true;

		if (animationFrameId != null) {
			windowRef.cancelAnimationFrame(animationFrameId);
		}

		for (const cleanup of cleanupFns.splice(0)) cleanup();

		if (hover.mesh && hover.savedEmissive != null) {
			const material = hover.mesh.material;
			if (material?.emissive) material.emissive.setHex(hover.savedEmissive);
		}

		if (musicSource) {
			musicSource.onended = null;
			try {
				musicSource.stop();
			} catch (error) {
				console.warn("Unable to stop music source cleanly:", error);
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
		envDebugMaterial.dispose();
		renderer.dispose();
		disposeSceneGraph(scene);

		if (renderer.domElement.parentNode === container) {
			container.removeChild(renderer.domElement);
		}

		projectileBodies.clear();
		bodyToMesh.clear();
		meshToBody.clear();
		originalEnvMaterials.clear();
		debugVisuals.orc = [];
		debugVisuals.bartender = [];
		boneColliders.orc = [];
		boneColliders.bartender = [];
		playerBody = null;
	};
}
