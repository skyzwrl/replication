/// <reference types="@rbxts/testez/globals" />

import { ReplicationClient } from "../client";
import { LoopbackNetwork } from "../loopback";
import { ReplicationServer } from "../server";
import { ClientTransport, ReliableMessage } from "../transport";
import { packet } from "./fixtures";

interface Puppet {
	key: string;
	data: unknown;
	applied: CFrame[];
}

const idle: ClientTransport<string> = {
	connect() {
		return () => {};
	},
};

export = () => {
	let now = 0;
	let despawned: string[];

	function createClient() {
		return new ReplicationClient<string, Puppet>({
			transport: idle,
			spawn: (key, data) => ({ key, data, applied: [] }),
			despawn: (puppet) => despawned.push(puppet.key),
			apply: (puppet, cframe) => puppet.applied.push(cframe),
			clock: () => now,
		});
	}

	function spawnMessage(id: number, key: string, time: number, cframe: CFrame): ReliableMessage<string> {
		return { spawns: [{ id, key, data: `${key} data`, time, cframe }], despawns: [] };
	}

	function renderedX(client: ReplicationClient<string, Puppet>, key: string): number {
		const rendered = client.getRendered(key);
		expect(rendered).to.be.ok();
		return rendered!.Position.X;
	}

	beforeEach(() => {
		now = 0;
		despawned = [];
	});

	it("spawns through the hook with the spawn data and despawns through the other", () => {
		const client = createClient();
		client.receiveReliable(spawnMessage(4, "golem", 0, new CFrame(1, 2, 3)));
		expect(client.entityCount()).to.equal(1);
		expect(client.getHandle("golem")!.data).to.equal("golem data");

		client.receiveReliable({ spawns: [], despawns: [4] });
		expect(client.entityCount()).to.equal(0);
		expect(despawned.join(",")).to.equal("golem");
	});

	it("renders between snapshots, interpolation delay behind the server clock", () => {
		const client = createClient();
		client.receiveReliable(spawnMessage(1, "npc", 0, new CFrame(0, 0, 0)));
		client.receiveSnapshot(packet(0, 0.05, [[1, new CFrame(5, 0, 0)]]));
		client.receiveSnapshot(packet(1, 0.1, [[1, new CFrame(10, 0, 0)]]));

		now = 0.175;
		client.render();
		expect(renderedX(client, "npc")).to.be.near(7.5, 1e-3);
		expect(client.getHandle("npc")!.applied.size()).to.equal(1);
	});

	it("drops stale and repeated sequences, including across the wrap", () => {
		const client = createClient();
		expect(client.receiveSnapshot(packet(65534, 1, []))).to.equal(true);
		expect(client.receiveSnapshot(packet(65535, 1.05, []))).to.equal(true);
		expect(client.receiveSnapshot(packet(0, 1.1, []))).to.equal(true);
		expect(client.receiveSnapshot(packet(65535, 1.05, []))).to.equal(false);
		expect(client.receiveSnapshot(packet(0, 1.1, []))).to.equal(false);
		expect(client.receiveSnapshot(packet(1, 1.15, []))).to.equal(true);
	});

	it("ignores ids it hasn't spawned and samples older than the spawn", () => {
		const client = createClient();
		client.receiveReliable(spawnMessage(1, "npc", 1, new CFrame(0, 0, 0)));
		expect(client.receiveSnapshot(packet(0, 0.5, [[1, new CFrame(50, 0, 0)]]))).to.equal(true);
		expect(client.receiveSnapshot(packet(1, 1.05, [[9, new CFrame(70, 0, 0)]]))).to.equal(true);

		now = 2;
		client.render();
		expect(renderedX(client, "npc")).to.equal(0);
	});

	it("rejects packets with a broken length", () => {
		const client = createClient();
		expect(client.receiveSnapshot(buffer.create(13))).to.equal(false);
	});

	it("replaces an entity when its id is spawned again", () => {
		const client = createClient();
		client.receiveReliable(spawnMessage(2, "old", 0, new CFrame()));
		client.receiveReliable({
			spawns: [{ id: 2, key: "new", time: 1, cframe: new CFrame(9, 0, 0) }],
			despawns: [2],
		});
		expect(despawned.join(",")).to.equal("old");
		expect(client.entityCount()).to.equal(1);
		expect(client.getHandle("old")).never.to.be.ok();
		expect(client.getHandle("new")).to.be.ok();
	});

	it("listens to its transport once started and lets go when stopped", () => {
		const network = new LoopbackNetwork<string, string>({ clock: () => now });
		const server = new ReplicationServer<string, string>({
			transport: network,
			getFocus: () => Vector3.zero,
			clock: () => now,
		});
		server.register("totem", () => new CFrame(3, 0, 0));
		server.addPeer("alice");

		const client = new ReplicationClient<string, Puppet>({
			transport: network.client("alice"),
			spawn: (key, data) => ({ key, data, applied: [] }),
			apply: () => {},
			clock: () => now,
		});
		client.start();
		server.tick();
		network.deliver();
		expect(client.entityCount()).to.equal(1);

		client.stop();
		server.unregister("totem");
		server.tick();
		network.deliver();
		expect(client.entityCount()).to.equal(1);
	});
};
