/// <reference types="@rbxts/testez/globals" />

import { isNewerSequence, nextSequence } from "../sequence";

export = () => {
	describe("sequence numbers", () => {
		it("counts up and wraps at 16 bits", () => {
			expect(nextSequence(41)).to.equal(42);
			expect(nextSequence(65535)).to.equal(0);
		});

		it("treats later numbers as newer and equal ones as not", () => {
			expect(isNewerSequence(11, 10)).to.equal(true);
			expect(isNewerSequence(10, 11)).to.equal(false);
			expect(isNewerSequence(10, 10)).to.equal(false);
		});

		it("still orders correctly across the wrap", () => {
			expect(isNewerSequence(0, 65535)).to.equal(true);
			expect(isNewerSequence(3, 65530)).to.equal(true);
			expect(isNewerSequence(65530, 3)).to.equal(false);
			expect(isNewerSequence(65535, 0)).to.equal(false);
		});

		it("splits the range in half to decide which side is newer", () => {
			expect(isNewerSequence(32767, 0)).to.equal(true);
			expect(isNewerSequence(32768, 0)).to.equal(false);
			expect(isNewerSequence(0, 32768)).to.equal(false);
			expect(isNewerSequence(0, 32769)).to.equal(true);
		});
	});
};
