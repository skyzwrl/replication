// packet: u16 sequence, f64 server time, then fixed size entity records
// entity: u16 (net id << 2 | dropped quaternion component), 3 x f32 position, 3 x i16 rotation
export const HEADER_SIZE = 10;
export const ENTITY_SIZE = 20;
export const MAX_NET_ID = 16383;

// smallest three: the largest quaternion component is dropped and rebuilt from the others, which can
// then only lie in [-1/sqrt2, 1/sqrt2]. scaling that range onto i16 keeps the angular error under 1e-4 rad
const ROTATION_SCALE = 32767 / math.sqrt(0.5);

export class QuantizedTransform {
	public x = 0;
	public y = 0;
	public z = 0;
	public dropped = 3;
	public a = 0;
	public b = 0;
	public c = 0;

	public copyFrom(other: QuantizedTransform): void {
		this.x = other.x;
		this.y = other.y;
		this.z = other.z;
		this.dropped = other.dropped;
		this.a = other.a;
		this.b = other.b;
		this.c = other.c;
	}
}

function quantizeComponent(value: number): number {
	return math.clamp(math.round(value * ROTATION_SCALE), -32767, 32767);
}

export function quantize(cframe: CFrame, out: QuantizedTransform): QuantizedTransform {
	const [x, y, z, r00, r01, r02, r10, r11, r12, r20, r21, r22] = cframe.GetComponents();
	out.x = x;
	out.y = y;
	out.z = z;

	let qx: number, qy: number, qz: number, qw: number;
	const trace = r00 + r11 + r22;
	if (trace > 0) {
		const s = math.sqrt(trace + 1) * 2;
		qw = s / 4;
		qx = (r21 - r12) / s;
		qy = (r02 - r20) / s;
		qz = (r10 - r01) / s;
	} else if (r00 > r11 && r00 > r22) {
		const s = math.sqrt(1 + r00 - r11 - r22) * 2;
		qw = (r21 - r12) / s;
		qx = s / 4;
		qy = (r01 + r10) / s;
		qz = (r02 + r20) / s;
	} else if (r11 > r22) {
		const s = math.sqrt(1 + r11 - r00 - r22) * 2;
		qw = (r02 - r20) / s;
		qx = (r01 + r10) / s;
		qy = s / 4;
		qz = (r12 + r21) / s;
	} else {
		const s = math.sqrt(1 + r22 - r00 - r11) * 2;
		qw = (r10 - r01) / s;
		qx = (r02 + r20) / s;
		qy = (r12 + r21) / s;
		qz = s / 4;
	}

	let dropped = 0;
	let largest = math.abs(qx);
	if (math.abs(qy) > largest) {
		dropped = 1;
		largest = math.abs(qy);
	}
	if (math.abs(qz) > largest) {
		dropped = 2;
		largest = math.abs(qz);
	}
	if (math.abs(qw) > largest) {
		dropped = 3;
	}

	// q and -q are the same rotation, flipping keeps the dropped component positive so it can be rebuilt
	const sign = (dropped === 0 ? qx : dropped === 1 ? qy : dropped === 2 ? qz : qw) < 0 ? -1 : 1;
	out.dropped = dropped;
	if (dropped === 0) {
		out.a = quantizeComponent(qy * sign);
		out.b = quantizeComponent(qz * sign);
		out.c = quantizeComponent(qw * sign);
	} else if (dropped === 1) {
		out.a = quantizeComponent(qx * sign);
		out.b = quantizeComponent(qz * sign);
		out.c = quantizeComponent(qw * sign);
	} else if (dropped === 2) {
		out.a = quantizeComponent(qx * sign);
		out.b = quantizeComponent(qy * sign);
		out.c = quantizeComponent(qw * sign);
	} else {
		out.a = quantizeComponent(qx * sign);
		out.b = quantizeComponent(qy * sign);
		out.c = quantizeComponent(qz * sign);
	}
	return out;
}

export function writeHeader(target: buffer, sequence: number, time: number): void {
	buffer.writeu16(target, 0, sequence);
	buffer.writef64(target, 2, time);
}

export function readSequence(source: buffer): number {
	return buffer.readu16(source, 0);
}

export function readTime(source: buffer): number {
	return buffer.readf64(source, 2);
}

export function writeEntity(target: buffer, offset: number, id: number, transform: QuantizedTransform): void {
	buffer.writeu16(target, offset, id * 4 + transform.dropped);
	buffer.writef32(target, offset + 2, transform.x);
	buffer.writef32(target, offset + 6, transform.y);
	buffer.writef32(target, offset + 10, transform.z);
	buffer.writei16(target, offset + 14, transform.a);
	buffer.writei16(target, offset + 16, transform.b);
	buffer.writei16(target, offset + 18, transform.c);
}

export function readNetId(source: buffer, offset: number): number {
	return math.floor(buffer.readu16(source, offset) / 4);
}

export function readTransform(source: buffer, offset: number): CFrame {
	const dropped = buffer.readu16(source, offset) % 4;
	const x = buffer.readf32(source, offset + 2);
	const y = buffer.readf32(source, offset + 6);
	const z = buffer.readf32(source, offset + 10);
	const a = buffer.readi16(source, offset + 14) / ROTATION_SCALE;
	const b = buffer.readi16(source, offset + 16) / ROTATION_SCALE;
	const c = buffer.readi16(source, offset + 18) / ROTATION_SCALE;
	const rebuilt = math.sqrt(math.max(1 - a * a - b * b - c * c, 0));

	if (dropped === 0) {
		return new CFrame(x, y, z, rebuilt, a, b, c);
	} else if (dropped === 1) {
		return new CFrame(x, y, z, a, rebuilt, b, c);
	} else if (dropped === 2) {
		return new CFrame(x, y, z, a, b, rebuilt, c);
	}
	return new CFrame(x, y, z, a, b, c, rebuilt);
}

export function isValidPacket(packet: buffer): boolean {
	const length = buffer.len(packet);
	return length >= HEADER_SIZE && (length - HEADER_SIZE) % ENTITY_SIZE === 0;
}
