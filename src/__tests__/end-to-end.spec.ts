/// <reference types="@rbxts/testez/globals" />

import { ReplicationClient } from "../client";
import { LoopbackNetwork } from "../loopback";
import { ReplicationServer } from "../server";

const FRAME = 1 / 60;
const TICK = 1 / 20;
const DELAY = 0.1;

class Simulation {
	public now = 0;
	public readonly network: LoopbackNetwork<string, string>;
	public readonly server: ReplicationServer<string, string>;
	public readonly client: ReplicationClient<string, string>;
	public focus = Vector3.zero;
	private nextTick = 0;

	public constructor(network: { latency: number; jitter: number; loss: number; seed: number }, keyframeInterval = 1) {
		this.network = new LoopbackNetwork({ ...network, clock: () => this.now });
		this.server = new ReplicationServer({
			transport: this.network,
			getFocus: () => this.focus,
			interestRadius: 200,
			keyframeInterval,
			clock: () => this.now,
		});
		const transport = this.network.client("alice");
		this.client = new ReplicationClient({
			transport,
			spawn: (key) => key,
			apply: () => {},
			interpolationDelay: DELAY,
			clock: () => this.now,
		});
		// wired by hand instead of start(), which would also hook the client to the real render loop
		transport.connect(
			(packet) => this.client.receiveSnapshot(packet),
			(message) => this.client.receiveReliable(message),
		);
		this.server.addPeer("alice");
	}

	public frame(): void {
		this.now += FRAME;
		if (this.now >= this.nextTick) {
			this.server.tick();
			this.nextTick += TICK;
		}
		this.network.deliver();
		this.client.render();
	}
}

function orbit(time: number): CFrame {
	return CFrame.Angles(0, time, 0).mul(new CFrame(0, 0, -20));
}

export = () => {
	it("tracks a moving entity through latency, jitter and loss", () => {
		const simulation = new Simulation({ latency: 0.08, jitter: 0.03, loss: 0.1, seed: 42 });
		simulation.server.register("orbiter", () => orbit(simulation.now));

		let worst = 0;
		for (let frame = 0; frame < 60 * 5; frame++) {
			simulation.frame();
			if (simulation.now > 1) {
				const rendered = simulation.client.getRendered("orbiter");
				expect(rendered).to.be.ok();
				const shown = orbit(simulation.client.getRenderTime()).Position;
				worst = math.max(worst, rendered!.Position.sub(shown).Magnitude);
			}
		}
		expect(simulation.network.dropped > 0).to.equal(true);
		expect(worst < 0.2).to.equal(true);
	});

	it("renders far enough behind to cover the measured ping", () => {
		const simulation = new Simulation({ latency: 0.15, jitter: 0.02, loss: 0, seed: 11 });
		simulation.server.register("orbiter", () => orbit(simulation.now));
		for (let frame = 0; frame < 60 * 3; frame++) {
			simulation.frame();
		}
		const behind = simulation.now - simulation.client.getRenderTime();
		expect(behind > DELAY + 0.15).to.equal(true);
		expect(behind < DELAY + 0.15 + 0.1).to.equal(true);
	});

	it("settles on the final pose after every packet carrying it was lost", () => {
		const simulation = new Simulation({ latency: 0.05, jitter: 0, loss: 0, seed: 7 }, 0.5);
		const stopAt = 1;
		simulation.server.register("walker", () => new CFrame(math.min(simulation.now, stopAt) * 10, 0, 0));

		while (simulation.now < 3) {
			// lose everything from just before the stop until well after the redundant resends
			simulation.network.loss = simulation.now > 0.95 && simulation.now < 1.4 ? 1 : 0;
			simulation.frame();
		}

		const rendered = simulation.client.getRendered("walker");
		expect(rendered).to.be.ok();
		expect(rendered!.Position.X).to.be.near(10, 1e-3);
		expect(simulation.network.dropped > 0).to.equal(true);
	});

	it("spawns and despawns as the peer's focus moves around", () => {
		const simulation = new Simulation({ latency: 0.05, jitter: 0, loss: 0, seed: 3 });
		simulation.server.register("tower", () => new CFrame(0, 0, 0));

		for (let frame = 0; frame < 30; frame++) {
			simulation.frame();
		}
		expect(simulation.client.entityCount()).to.equal(1);

		simulation.focus = new Vector3(5000, 0, 0);
		for (let frame = 0; frame < 30; frame++) {
			simulation.frame();
		}
		expect(simulation.client.entityCount()).to.equal(0);

		simulation.focus = Vector3.zero;
		for (let frame = 0; frame < 30; frame++) {
			simulation.frame();
		}
		expect(simulation.client.entityCount()).to.equal(1);
		expect(simulation.client.getRendered("tower")!.Position.X).to.equal(0);
	});

	it("costs nothing between keyframes when nothing moves", () => {
		const simulation = new Simulation({ latency: 0, jitter: 0, loss: 0, seed: 1 }, 1);
		for (let index = 0; index < 50; index++) {
			simulation.server.register(`statue${index}`, () => new CFrame(index, 0, 0));
		}
		for (let frame = 0; frame < 60 * 3; frame++) {
			simulation.frame();
		}
		// one keyframe a second over three seconds, 50 statues split into packets of up to 44
		expect(simulation.network.sent <= 6).to.equal(true);
		expect(simulation.network.sent >= 4).to.equal(true);
	});
};
