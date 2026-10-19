const CELL_RANGE = 65536;
const CELL_OFFSET = 32768;

// flat XZ grid. entities that replicate are mostly spread across a map rather than stacked vertically,
// so 9 cells around the focus are enough and the exact 3D distance check happens afterwards
export class Grid<T extends defined> {
	private readonly cells = new Map<number, Set<T>>();
	private readonly cellOf = new Map<T, number>();

	public constructor(private readonly cellSize: number) {}

	public insert(item: T, position: Vector3): void {
		const key = this.keyOf(position.X, position.Z);
		this.cellOf.set(item, key);
		this.cellAt(key).add(item);
	}

	public move(item: T, position: Vector3): void {
		const previous = this.cellOf.get(item);
		const key = this.keyOf(position.X, position.Z);
		if (previous === key) {
			return;
		}
		if (previous !== undefined) {
			this.leave(item, previous);
		}
		this.cellOf.set(item, key);
		this.cellAt(key).add(item);
	}

	public remove(item: T): void {
		const key = this.cellOf.get(item);
		if (key !== undefined) {
			this.leave(item, key);
			this.cellOf.delete(item);
		}
	}

	// candidates only, callers still check the real distance
	public query(center: Vector3, radius: number, out: T[]): T[] {
		out.clear();
		const size = this.cellSize;
		const minX = this.clampCell(math.floor((center.X - radius) / size));
		const maxX = this.clampCell(math.floor((center.X + radius) / size));
		const minZ = this.clampCell(math.floor((center.Z - radius) / size));
		const maxZ = this.clampCell(math.floor((center.Z + radius) / size));

		for (let cellX = minX; cellX <= maxX; cellX++) {
			for (let cellZ = minZ; cellZ <= maxZ; cellZ++) {
				const cell = this.cells.get((cellX + CELL_OFFSET) * CELL_RANGE + cellZ + CELL_OFFSET);
				if (cell !== undefined) {
					for (const item of cell) {
						out.push(item);
					}
				}
			}
		}
		return out;
	}

	private keyOf(x: number, z: number): number {
		const cellX = this.clampCell(math.floor(x / this.cellSize));
		const cellZ = this.clampCell(math.floor(z / this.cellSize));
		return (cellX + CELL_OFFSET) * CELL_RANGE + cellZ + CELL_OFFSET;
	}

	private clampCell(cell: number): number {
		return math.clamp(cell, -CELL_OFFSET, CELL_OFFSET - 1);
	}

	private cellAt(key: number): Set<T> {
		let cell = this.cells.get(key);
		if (cell === undefined) {
			cell = new Set();
			this.cells.set(key, cell);
		}
		return cell;
	}

	private leave(item: T, key: number): void {
		const cell = this.cells.get(key);
		if (cell !== undefined) {
			cell.delete(item);
			if (cell.isEmpty()) {
				this.cells.delete(key);
			}
		}
	}
}
