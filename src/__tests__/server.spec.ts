/// <reference types="@rbxts/testez/globals" />

import { HEADER_SIZE } from "../codec";
import { ReplicationServer } from "../server";
import { RecordingTransport, idsIn } from "./fixtures";

export = () => {
	let now = 0;
	let transport: RecordingTransport<string, string>;
	let focus: Map<string, Vector3 | undefined>;
	let poses: Map<string, CFrame>;

	function createServer(overrides?: { interestRadius?: number; keyframeInterval?: number; maxPacketSize?: number }) {
		return new ReplicationServer<string, string>({
			transport,
			getFocus: (peer) => focus.get(peer),
			interestRadius: overrides?.interestRadius ?? 100,
			keyframeInterval: overrides?.keyframeInterval ?? 1,
			maxPacketSize: overrides?.maxPacketSize,
			redundancy: 3,
			clock: () => now,
		});
	}

	function track(server: ReplicationServer<string, string>, key: string, cframe: CFrame): number {
		poses.set(key, cframe);
		return server.register(key, () => poses.get(key)!);
	}

	function step(server: ReplicationServer<string, string>): void {
		now += 0.05;
		server.tick();
	}

	beforeEach(() => {
		now = 0;
		transport = new RecordingTransport();
		focus = new Map([["alice", Vector3.zero]]);
		poses = new Map();
	});

	describe("interest", () => {
		it("spawns entities inside the radius with their current pose and skips the rest", () => {
			const server = createServer();
			track(server, "near", new CFrame(30, 0, 0));
			track(server, "far", new CFrame(1000, 0, 0));
			server.addPeer("alice");
			step(server);

			expect(transport.spawnedKeys("alice").join(",")).to.equal("near");
			const spawn = transport.reliable[0].message.spawns[0];
			expect(spawn.cframe.Position.X).to.equal(30);
			expect(spawn.time).to.equal(now);
		});

		it("waits past the leave radius before despawning something on the edge", () => {
			const server = createServer();
			const id = track(server, "drifter", new CFrame(90, 0, 0));
			server.addPeer("alice");
			step(server);

			poses.set("drifter", new CFrame(105, 0, 0));
			step(server);
			expect(transport.despawnedIds("alice").size()).to.equal(0);

			poses.set("drifter", new CFrame(115, 0, 0));
			step(server);
			expect(transport.despawnedIds("alice").join(",")).to.equal(`${id}`);
		});

		it("despawns for every peer that knew an unregistered entity", () => {
			const server = createServer();
			focus.set("bob", new Vector3(10, 0, 0));
			const id = track(server, "crate", new CFrame(5, 0, 0));
			server.addPeer("alice");
			server.addPeer("bob");
			step(server);

			server.unregister("crate");
			step(server);
			expect(transport.despawnedIds("alice").join(",")).to.equal(`${id}`);
			expect(transport.despawnedIds("bob").join(",")).to.equal(`${id}`);
			expect(server.isRegistered("crate")).to.equal(false);
		});

		it("keeps the current set while a peer has no focus", () => {
			const server = createServer();
			track(server, "crate", new CFrame(5, 0, 0));
			server.addPeer("alice");
			step(server);

			focus.set("alice", undefined);
			poses.set("crate", new CFrame(5000, 0, 0));
			step(server);
			expect(transport.despawnedIds("alice").size()).to.equal(0);
		});
	});

	describe("snapshots", () => {
		it("sends an entity on the tick it moves plus the redundancy ticks after, then goes quiet", () => {
			const server = createServer({ keyframeInterval: 100 });
			const id = track(server, "npc", new CFrame(0, 0, 0));
			server.addPeer("alice");
			step(server);
			expect(transport.snapshotsFor("alice").size()).to.equal(0);

			poses.set("npc", new CFrame(1, 0, 0));
			for (let tick = 0; tick < 6; tick++) {
				step(server);
			}
			const packets = transport.snapshotsFor("alice");
			expect(packets.size()).to.equal(4);
			for (const source of packets) {
				expect(idsIn(source).join(",")).to.equal(`${id}`);
			}
		});

		it("ignores movement below the thresholds", () => {
			const server = createServer({ keyframeInterval: 100 });
			track(server, "npc", new CFrame(0, 0, 0));
			server.addPeer("alice");
			step(server);

			poses.set("npc", new CFrame(0.004, 0, 0).mul(CFrame.Angles(0, 0.0002, 0)));
			step(server);
			step(server);
			expect(transport.snapshotsFor("alice").size()).to.equal(0);
		});

		it("resends everything a peer knows on keyframes", () => {
			const server = createServer({ keyframeInterval: 0.5 });
			const first = track(server, "a", new CFrame(1, 0, 0));
			const second = track(server, "b", new CFrame(2, 0, 0));
			server.addPeer("alice");
			for (let tick = 0; tick < 10; tick++) {
				step(server);
			}

			const packets = transport.snapshotsFor("alice");
			expect(packets.size() >= 1).to.equal(true);
			const ids = idsIn(packets[0]);
			ids.sort();
			expect(ids.join(",")).to.equal(`${first},${second}`);
		});

		it("splits big snapshots below the packet size limit with consecutive sequences", () => {
			const server = createServer({ maxPacketSize: 300 });
			for (let index = 0; index < 40; index++) {
				track(server, `npc${index}`, new CFrame(index, 0, 0));
			}
			server.addPeer("alice");
			step(server);
			for (let index = 0; index < 40; index++) {
				poses.set(`npc${index}`, new CFrame(index, 5, 0));
			}
			step(server);

			const packets = transport.snapshotsFor("alice");
			let total = 0;
			let expected = buffer.readu16(packets[0], 0);
			for (const source of packets) {
				expect(buffer.len(source) <= 300).to.equal(true);
				expect(buffer.readu16(source, 0)).to.equal(expected);
				expected += 1;
				total += idsIn(source).size();
			}
			expect(packets.size() > 1).to.equal(true);
			expect(total).to.equal(40);
		});

		it("stamps packets with the server clock", () => {
			const server = createServer();
			track(server, "npc", new CFrame());
			server.addPeer("alice");
			step(server);
			poses.set("npc", new CFrame(3, 0, 0));
			step(server);
			const packets = transport.snapshotsFor("alice");
			expect(buffer.len(packets[0]) > HEADER_SIZE).to.equal(true);
			expect(buffer.readf64(packets[0], 2)).to.equal(now);
		});

		it("staggers the keyframes of peers that join together", () => {
			const server = createServer({ keyframeInterval: 1 });
			focus.set("bob", Vector3.zero);
			focus.set("cara", Vector3.zero);
			track(server, "statue", new CFrame());
			server.addPeer("alice");
			server.addPeer("bob");
			server.addPeer("cara");

			const firstKeyframe = new Map<string, number>();
			for (let tick = 0; tick < 25; tick++) {
				step(server);
				for (const entry of transport.snapshots) {
					if (!firstKeyframe.has(entry.peer)) {
						firstKeyframe.set(entry.peer, now);
					}
				}
				transport.clear();
			}
			expect(firstKeyframe.get("alice")).never.to.equal(firstKeyframe.get("bob"));
			expect(firstKeyframe.get("bob")).never.to.equal(firstKeyframe.get("cara"));
		});
	});

	describe("registration", () => {
		it("reuses the ids of unregistered entities", () => {
			const server = createServer();
			const first = track(server, "a", new CFrame());
			track(server, "b", new CFrame());
			server.unregister("a");
			expect(track(server, "c", new CFrame())).to.equal(first);
		});

		it("refuses to register the same key twice", () => {
			const server = createServer();
			track(server, "a", new CFrame());
			expect(() => server.register("a", () => new CFrame())).to.throw("already replicated");
		});
	});
};
