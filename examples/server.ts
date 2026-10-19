import { RunService, Workspace } from "@rbxts/services";
import { bindPlayers, RemoteServerTransport, ReplicationServer } from "@skyzwrl/replication";

interface Walker {
	key: string;
	origin: Vector3;
	radius: number;
	speed: number;
	cframe: CFrame;
}

// the walkers never exist in Workspace on the server, so the engine has nothing to replicate. clients
// build their own copies from the spawn data and move them from the snapshots
const server = new ReplicationServer<string>({
	transport: new RemoteServerTransport(),
	interestRadius: 400,
});

const walkers = new Array<Walker>();
for (let index = 0; index < 200; index++) {
	const walker: Walker = {
		key: `walker${index}`,
		origin: new Vector3(math.random(-500, 500), 3, math.random(-500, 500)),
		radius: math.random(10, 40),
		speed: 0.25 + math.random() * 0.5,
		cframe: new CFrame(),
	};
	walkers.push(walker);
	// the spawn data tells clients which model to build for it
	server.register(walker.key, () => walker.cframe, "Walker");
}

// game logic moves the walkers however it likes, replication only reads the result each tick
RunService.Heartbeat.Connect(() => {
	const now = Workspace.GetServerTimeNow();
	for (const walker of walkers) {
		const angle = now * walker.speed;
		const position = walker.origin.add(new Vector3(math.cos(angle), 0, math.sin(angle)).mul(walker.radius));
		const heading = new Vector3(-math.sin(angle), 0, math.cos(angle));
		walker.cframe = CFrame.lookAt(position, position.add(heading));
	}
});

bindPlayers(server);
server.start();
