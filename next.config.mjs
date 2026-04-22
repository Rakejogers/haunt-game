import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
	outputFileTracingRoot: __dirname,
	async headers() {
		return [
			{
				source: "/:path*",
				headers: [
					{
						key: "Cross-Origin-Embedder-Policy",
						value: "require-corp",
					},
					{
						key: "Cross-Origin-Opener-Policy",
						value: "same-origin",
					},
				],
			},
			{
				source: "/:path*.wasm",
				headers: [
					{
						key: "Content-Type",
						value: "application/wasm",
					},
				],
			},
		];
	},
};

export default nextConfig;
