import TavernGame from "./TavernGame";

export default function Page() {
	return <TavernGame runtimeEnvironment={process.env.NODE_ENV ?? ""} />;
}
