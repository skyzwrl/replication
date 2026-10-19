// samples further apart than this aren't consecutive ticks of something moving, the velocity they imply is
// a guess (an entity that went quiet, or a gap from packet loss), so starving entities hold instead
const MAX_VELOCITY_GAP = 0.25;

export class SnapshotBuffer {
	private readonly times: number[];
	private readonly cframes: CFrame[];
	private first = 0;
	private count = 0;

	public constructor(private readonly capacity: number) {
		this.times = new Array(capacity);
		this.cframes = new Array(capacity);
	}

	public size(): number {
		return this.count;
	}

	public newestTime(): number | undefined {
		return this.count > 0 ? this.times[this.slot(this.count - 1)] : undefined;
	}

	// samples arrive in time order per entity, anything that isn't newer than what's stored is stale
	public push(time: number, cframe: CFrame): boolean {
		const capacity = this.capacity;
		if (this.count > 0 && time <= this.times[this.slot(this.count - 1)]) {
			return false;
		}
		if (this.count < capacity) {
			const index = this.slot(this.count);
			this.times[index] = time;
			this.cframes[index] = cframe;
			this.count += 1;
		} else {
			this.times[this.first] = time;
			this.cframes[this.first] = cframe;
			this.first = (this.first + 1) % capacity;
		}
		return true;
	}

	public sample(time: number, maxExtrapolation: number, snapDistance: number): CFrame | undefined {
		const count = this.count;
		if (count === 0) {
			return undefined;
		}

		const newest = this.slot(count - 1);
		if (time >= this.times[newest]) {
			return this.extrapolate(time - this.times[newest], maxExtrapolation, snapDistance);
		}

		const oldest = this.slot(0);
		if (time <= this.times[oldest]) {
			return this.cframes[oldest];
		}

		let low = 0;
		let high = count - 1;
		while (low < high) {
			const middle = math.floor((low + high + 1) / 2);
			if (this.times[this.slot(middle)] <= time) {
				low = middle;
			} else {
				high = middle - 1;
			}
		}

		const from = this.slot(low);
		const to = this.slot(low + 1);
		const start = this.cframes[from];
		const finish = this.cframes[to];
		// a jump this big is a teleport, sliding across the map between the two samples would look wrong
		if (finish.Position.sub(start.Position).Magnitude > snapDistance) {
			return start;
		}
		return start.Lerp(finish, (time - this.times[from]) / (this.times[to] - this.times[from]));
	}

	private extrapolate(ahead: number, maxExtrapolation: number, snapDistance: number): CFrame {
		const newestIndex = this.slot(this.count - 1);
		const newest = this.cframes[newestIndex];
		if (this.count < 2 || ahead <= 0 || maxExtrapolation <= 0) {
			return newest;
		}

		const previousIndex = this.slot(this.count - 2);
		const gap = this.times[newestIndex] - this.times[previousIndex];
		const travelled = newest.Position.sub(this.cframes[previousIndex].Position);
		if (gap > MAX_VELOCITY_GAP || travelled.Magnitude > snapDistance) {
			return newest;
		}
		// carry on at the last known velocity for a moment, then hold there rather than drifting off
		return newest.add(travelled.mul(math.min(ahead, maxExtrapolation) / gap));
	}

	private slot(index: number): number {
		return (this.first + index) % this.capacity;
	}
}
