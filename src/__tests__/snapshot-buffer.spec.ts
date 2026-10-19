/// <reference types="@rbxts/testez/globals" />

import { SnapshotBuffer } from "../snapshot-buffer";

export = () => {
	function x(cframe: CFrame | undefined): number {
		expect(cframe).to.be.ok();
		return cframe!.Position.X;
	}

	describe("snapshot buffer", () => {
		it("interpolates between the two samples around the requested time", () => {
			const snapshots = new SnapshotBuffer(8);
			snapshots.push(1, new CFrame(0, 0, 0));
			snapshots.push(1.05, new CFrame(10, 0, 0));
			snapshots.push(1.1, new CFrame(30, 0, 0));

			expect(x(snapshots.sample(1.025, 0.1, 100))).to.be.near(5, 1e-4);
			expect(x(snapshots.sample(1.075, 0.1, 100))).to.be.near(20, 1e-4);
			expect(x(snapshots.sample(1.05, 0.1, 100))).to.be.near(10, 1e-4);
		});

		it("clamps to the oldest sample before the window", () => {
			const snapshots = new SnapshotBuffer(8);
			snapshots.push(2, new CFrame(4, 0, 0));
			snapshots.push(3, new CFrame(8, 0, 0));
			expect(x(snapshots.sample(0, 0.1, 100))).to.equal(4);
		});

		it("rejects samples that aren't newer than the latest", () => {
			const snapshots = new SnapshotBuffer(8);
			expect(snapshots.push(1, new CFrame())).to.equal(true);
			expect(snapshots.push(1, new CFrame(1, 0, 0))).to.equal(false);
			expect(snapshots.push(0.5, new CFrame(1, 0, 0))).to.equal(false);
			expect(snapshots.size()).to.equal(1);
		});

		it("overwrites the oldest samples once full", () => {
			const snapshots = new SnapshotBuffer(3);
			for (let index = 0; index < 5; index++) {
				snapshots.push(index, new CFrame(index * 10, 0, 0));
			}
			expect(snapshots.size()).to.equal(3);
			expect(x(snapshots.sample(0, 0.1, 100))).to.equal(20);
			expect(x(snapshots.sample(3.5, 0.1, 100))).to.be.near(35, 1e-4);
		});

		it("extrapolates for a bounded time when starved, then holds", () => {
			const snapshots = new SnapshotBuffer(8);
			snapshots.push(0, new CFrame(0, 0, 0));
			snapshots.push(0.05, new CFrame(5, 0, 0));

			expect(x(snapshots.sample(0.1, 0.1, 100))).to.be.near(10, 1e-4);
			expect(x(snapshots.sample(0.15, 0.1, 100))).to.be.near(15, 1e-4);
			expect(x(snapshots.sample(3, 0.1, 100))).to.be.near(15, 1e-4);
		});

		it("doesn't overshoot an entity that stopped", () => {
			const snapshots = new SnapshotBuffer(8);
			snapshots.push(0, new CFrame(0, 0, 0));
			snapshots.push(0.05, new CFrame(5, 0, 0));
			snapshots.push(0.1, new CFrame(5, 0, 0));
			expect(x(snapshots.sample(0.5, 0.1, 100))).to.equal(5);
		});

		it("holds instead of extrapolating from samples that weren't consecutive ticks", () => {
			const snapshots = new SnapshotBuffer(8);
			snapshots.push(0, new CFrame(9, 0, 0));
			snapshots.push(0.9, new CFrame(10, 0, 0));
			expect(x(snapshots.sample(1, 0.1, 100))).to.equal(10);
		});

		it("snaps across teleports instead of sliding", () => {
			const snapshots = new SnapshotBuffer(8);
			snapshots.push(0, new CFrame(0, 0, 0));
			snapshots.push(0.05, new CFrame(500, 0, 0));
			expect(x(snapshots.sample(0.04, 0.1, 64))).to.equal(0);
			expect(x(snapshots.sample(0.05, 0.1, 64))).to.equal(500);
			expect(x(snapshots.sample(0.2, 0.1, 64))).to.equal(500);
		});

		it("returns nothing before the first sample", () => {
			expect(new SnapshotBuffer(4).sample(1, 0.1, 100)).never.to.be.ok();
		});
	});
};
