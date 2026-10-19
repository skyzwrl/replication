/// <reference types="@rbxts/testez/globals" />

import {
	ENTITY_SIZE,
	HEADER_SIZE,
	MAX_NET_ID,
	QuantizedTransform,
	isValidPacket,
	quantize,
	readNetId,
	readSequence,
	readTime,
	readTransform,
	writeEntity,
	writeHeader,
} from "../codec";
import { Lcg, angleBetween, packet } from "./fixtures";

function roundTrip(cframe: CFrame, id = 1): CFrame {
	const source = buffer.create(ENTITY_SIZE);
	writeEntity(source, 0, id, quantize(cframe, new QuantizedTransform()));
	return readTransform(source, 0);
}

export = () => {
	describe("layout", () => {
		it("uses a 10 byte header and 20 bytes per entity", () => {
			expect(HEADER_SIZE).to.equal(10);
			expect(ENTITY_SIZE).to.equal(20);
			const source = packet(7, 12.5, [
				[1, new CFrame()],
				[2, new CFrame(1, 2, 3)],
				[3, new CFrame(4, 5, 6)],
			]);
			expect(buffer.len(source)).to.equal(70);
		});

		it("keeps the sequence and the full precision server time in the header", () => {
			const source = buffer.create(HEADER_SIZE);
			writeHeader(source, 65535, 1792406547.123456);
			expect(readSequence(source)).to.equal(65535);
			expect(readTime(source)).to.equal(1792406547.123456);
		});

		it("packs net ids up to the 14 bit limit next to the rotation index", () => {
			const source = buffer.create(ENTITY_SIZE * 2);
			const transform = quantize(CFrame.Angles(0, math.pi, 0), new QuantizedTransform());
			writeEntity(source, 0, MAX_NET_ID, transform);
			writeEntity(source, ENTITY_SIZE, 0, transform);
			expect(readNetId(source, 0)).to.equal(16383);
			expect(readNetId(source, ENTITY_SIZE)).to.equal(0);
		});

		it("rejects buffers that aren't a header plus whole entities", () => {
			expect(isValidPacket(buffer.create(HEADER_SIZE))).to.equal(true);
			expect(isValidPacket(buffer.create(HEADER_SIZE + ENTITY_SIZE * 2))).to.equal(true);
			expect(isValidPacket(buffer.create(HEADER_SIZE - 1))).to.equal(false);
			expect(isValidPacket(buffer.create(HEADER_SIZE + ENTITY_SIZE + 3))).to.equal(false);
		});
	});

	describe("transforms", () => {
		it("round trips positions at f32 precision", () => {
			const position = new Vector3(1234.5678, -98.765, 0.001);
			const decoded = roundTrip(new CFrame(position));
			expect(decoded.Position.X).to.be.near(position.X, 1e-3);
			expect(decoded.Position.Y).to.be.near(position.Y, 1e-4);
			expect(decoded.Position.Z).to.be.near(position.Z, 1e-6);
		});

		it("keeps random rotations within the quantization bound", () => {
			const random = new Lcg(12345);
			let worst = 0;
			for (let index = 0; index < 2000; index++) {
				const cframe = new CFrame(random.range(-500, 500), random.range(-50, 50), random.range(-500, 500)).mul(
					CFrame.Angles(
						random.range(-math.pi, math.pi),
						random.range(-math.pi, math.pi),
						random.range(-math.pi, math.pi),
					),
				);
				worst = math.max(worst, angleBetween(cframe, roundTrip(cframe)));
			}
			expect(worst < 1e-4).to.equal(true);
			expect(worst > 0).to.equal(true);
		});

		it("handles half turns where the scalar part is zero", () => {
			for (const rotation of [
				CFrame.Angles(math.pi, 0, 0),
				CFrame.Angles(0, math.pi, 0),
				CFrame.Angles(0, 0, math.pi),
				CFrame.Angles(0, math.pi / 2, 0),
				new CFrame(),
			]) {
				expect(angleBetween(rotation, roundTrip(rotation)) < 1e-4).to.equal(true);
			}
		});

		it("picks the same stored rotation for q and its negation", () => {
			const a = quantize(new CFrame(0, 0, 0, 0.5, 0.5, 0.5, 0.5), new QuantizedTransform());
			const b = quantize(new CFrame(0, 0, 0, -0.5, -0.5, -0.5, -0.5), new QuantizedTransform());
			expect(a.dropped).to.equal(b.dropped);
			expect(a.a).to.equal(b.a);
			expect(a.b).to.equal(b.b);
			expect(a.c).to.equal(b.c);
		});
	});
};
