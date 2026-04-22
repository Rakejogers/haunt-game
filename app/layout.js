import "./globals.css";

export const metadata = {
	title: "Haunt Game",
	description: "Interactive Three.js tavern demo powered by Next.js.",
};

const sparkImportMap = {
	imports: {
		three:
			"https://cdnjs.cloudflare.com/ajax/libs/three.js/0.180.0/three.module.js",
		"three/addons/":
			"https://cdn.jsdelivr.net/npm/three@0.180.0/examples/jsm/",
		"@sparkjsdev/spark":
			"https://sparkjs.dev/releases/spark/2.0.0/spark.module.js",
		"@dimforge/rapier3d-compat":
			"https://esm.sh/@dimforge/rapier3d-compat@0.12.0",
	},
};

export default function RootLayout({ children }) {
	return (
		<html lang="en">
			<head>
				<script
					type="importmap"
					dangerouslySetInnerHTML={{
						__html: JSON.stringify(sparkImportMap),
					}}
				/>
			</head>
			<body>{children}</body>
		</html>
	);
}
