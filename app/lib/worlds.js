export const CAMPAIGN_WORLDS = [
	{
		id: "vincenzo-library",
		name: "World 1: Don Vincenzo's Library",
		npcId: "donVincenzo",
		objectiveLabel: 'Convince Don Vincenzo of your loyalty so he gives up one of his boys name.',
		transitionTitle: "World 2 Unlocked",
		transitionBody:
			'Vincenzo finally trusted you with the first lead. Pietro is waiting somewhere in a narrow European lane, and he will bolt unless you calm him down first.',
		environment: {
			meshUrl: "/elegant_library_with_fireplace_collider.glb",
			meshScale: [-1, -1, 1],
			splatsUrl: "/elegant_library_with_fireplace_2m.spz",
			splatScale: [3, -3, 3],
			musicUrl: "/Vince_chi_resta.mp3",
			backgroundColor: 0x202020,
		},
		playerSpawn: {
			x: 0,
			z: 0,
			rayOriginY: 10,
			rayMaxDistance: 60,
			fallbackCenterY: 0.7,
		},
	},
	{
		id: "pietro-lane",
		name: "World 2: The Cobblestone Lane",
		npcId: "pietro",
		objectiveLabel:
			'Calm Pietro down until he reveals where the safehouse is and the password to get in.',
		transitionTitle: "World 3 Unlocked",
		transitionBody:
			'Pietro broke and gave you the countryside safehouse plus the password to get in. Now you need the courier inside: Clara.',
		environment: {
			meshUrl: "/narrow_european_cobblestone_lane_collider.glb",
			meshScale: [-0.833333333, -0.833333333, 0.833333333],
			splatsUrl: "/narrow_european_cobblestone_lane_2m.spz",
			splatScale: [2.5, -2.5, 2.5],
			musicUrl: "/Vince_chi_resta.mp3",
			backgroundColor: 0x141414,
		},
		playerSpawn: {
			x: 0,
			z: 0,
			rayOriginY: 10,
			rayMaxDistance: 60,
			fallbackCenterY: 0.7,
		},
	},
	{
		id: "clara-safehouse",
		name: "World 3: The Safehouse Kitchen",
		npcId: "clara",
		objectiveLabel:
			"Break Clara's cover, then get the private code access to Julian's estate.",
		transitionTitle: "World 4 Unlocked",
		transitionBody:
			'Clara admitted she moved the ledger along. The next stop is Julian, the collector who thought he bought the real thing. He has a private code to get in.',
		environment: {
			meshUrl: "/rustic_kitchen_with_natural_light_collider.glb",
			meshScale: [-0.75, -0.75, 0.75],
			splatsUrl: "/rustic_kitchen_with_natural_light_2m.spz",
			splatScale: [2.25, -2.25, 2.25],
			musicUrl: "/Vince_chi_resta.mp3",
			backgroundColor: 0x1a1712,
		},
		playerSpawn: {
			x: 0,
			z: 0,
			rayOriginY: 10,
			rayMaxDistance: 60,
			fallbackCenterY: 0.3,
		},
	},
	{
		id: "julian-estate",
		name: "World 4: Julian's Estate",
		npcId: "julian",
		objectiveLabel:
			'Work Julian\'s ego until he slips and gives up the name of the forger.',
		transitionTitle: "World 5 Unlocked",
		transitionBody:
			"Julian's pride did the work for you. The forgery trail ends in a warm kitchen, and Nonna Rosa has been expecting visitors like you.",
		environment: {
			meshUrl: "/modern_house_with_lush_landscaping_collider.glb",
			meshScale: [-1, -1, 1],
			splatsUrl: "/modern_house_with_lush_landscaping_2m.spz",
			splatScale: [3, -3, 3],
			musicUrl: "/Vince_chi_resta.mp3",
			backgroundColor: 0x13161a,
		},
		playerSpawn: {
			x: 0,
			z: 0,
			rayOriginY: 10,
			rayMaxDistance: 60,
			fallbackCenterY: 0.7,
		},
	},
	{
		id: "nonna-kitchen",
		name: "World 5: Nonna Rosa's Kitchen",
		npcId: "nonnaRosa",
		objectiveLabel:
			'Survive Nonna Rosa\'s mind games and learn where the real ledger is hidden.',
		transitionTitle: "Case Closed",
		transitionBody:
			"You reached the end of the chain. Nonna Rosa alone knows where the real Black Ledger rests inside the room.",
		environment: {
			meshUrl: "/warm_traditional_kitchen_interior_collider.glb",
			meshScale: [-0.75, -0.75, 0.75],
			splatsUrl: "/warm_traditional_kitchen_interior_2m.spz",
			splatScale: [2.25, -2.25, 2.25],
			musicUrl: "/Vince_chi_resta.mp3",
			backgroundColor: 0x18120f,
		},
		playerSpawn: {
			x: 0,
			z: 0,
			rayOriginY: 10,
			rayMaxDistance: 60,
			fallbackCenterY: 0.3,
		},
	},
];

export const DEFAULT_WORLD_ID = CAMPAIGN_WORLDS[0].id;

export function getWorldById(worldId) {
	return CAMPAIGN_WORLDS.find((world) => world.id === worldId) ?? CAMPAIGN_WORLDS[0];
}

export function getNextWorld(worldId) {
	const index = CAMPAIGN_WORLDS.findIndex((world) => world.id === worldId);

	if (index < 0 || index >= CAMPAIGN_WORLDS.length - 1) {
		return null;
	}

	return CAMPAIGN_WORLDS[index + 1];
}
