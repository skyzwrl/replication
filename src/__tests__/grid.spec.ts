/// <reference types="@rbxts/testez/globals" />

import { Grid } from "../grid";
import { Lcg } from "./fixtures";

export = () => {
	describe("grid", () => {
		it("returns every item within the radius as a candidate, matching a brute force scan", () => {
			const random = new Lcg(99);
			const grid = new Grid<number>(64);
			const positions = new Map<number, Vector3>();
			for (let item = 0; item < 400; item++) {
				const position = new Vector3(random.range(-600, 600), random.range(-20, 20), random.range(-600, 600));
				positions.set(item, position);
				grid.insert(item, position);
			}

			const candidates = new Array<number>();
			for (let query = 0; query < 50; query++) {
				const center = new Vector3(random.range(-600, 600), 0, random.range(-600, 600));
				const found = new Set(grid.query(center, 64, candidates));
				for (const [item, position] of positions) {
					const flat = new Vector3(position.X - center.X, 0, position.Z - center.Z);
					if (flat.Magnitude <= 64) {
						expect(found.has(item)).to.equal(true);
					}
				}
			}
		});

		it("moves items between cells and forgets removed ones", () => {
			const grid = new Grid<string>(10);
			const out = new Array<string>();
			grid.insert("crate", new Vector3(5, 0, 5));
			expect(grid.query(new Vector3(5, 0, 5), 1, out).join(",")).to.equal("crate");

			grid.move("crate", new Vector3(205, 0, 5));
			expect(grid.query(new Vector3(5, 0, 5), 1, out).size()).to.equal(0);
			expect(grid.query(new Vector3(205, 0, 5), 1, out).join(",")).to.equal("crate");

			grid.remove("crate");
			expect(grid.query(new Vector3(205, 0, 5), 1, out).size()).to.equal(0);
		});

		it("handles negative coordinates and clears the output array", () => {
			const grid = new Grid<string>(16);
			const out = ["stale"];
			grid.insert("left", new Vector3(-31, 0, -1));
			expect(grid.query(new Vector3(-20, 0, -5), 12, out).join(",")).to.equal("left");
		});
	});
};
