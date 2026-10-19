import { Players, ReplicatedStorage } from "@rbxts/services";
import { ReplicationServer } from "./server";
import { ClientTransport, ReliableMessage, ServerTransport } from "./transport";

export class RemoteServerTransport<K> implements ServerTransport<K, Player> {
	private readonly reliable: RemoteEvent;
	private readonly snapshots: UnreliableRemoteEvent;

	public constructor(name = "Replication", parent: Instance = ReplicatedStorage) {
		const folder = new Instance("Folder");
		folder.Name = name;
		this.reliable = new Instance("RemoteEvent");
		this.reliable.Name = "Reliable";
		this.reliable.Parent = folder;
		this.snapshots = new Instance("UnreliableRemoteEvent");
		this.snapshots.Name = "Snapshots";
		this.snapshots.Parent = folder;
		folder.Parent = parent;
	}

	public sendSnapshot(player: Player, packet: buffer): void {
		this.snapshots.FireClient(player, packet);
	}

	// keys and spawn data cross a RemoteEvent, so they have to be things it can carry (strings, numbers, instances)
	public sendReliable(player: Player, message: ReliableMessage<K>): void {
		this.reliable.FireClient(player, message);
	}
}

export class RemoteClientTransport<K> implements ClientTransport<K> {
	private readonly reliable: RemoteEvent;
	private readonly snapshots: UnreliableRemoteEvent;

	public constructor(name = "Replication", parent: Instance = ReplicatedStorage) {
		const folder = parent.WaitForChild(name);
		this.reliable = folder.WaitForChild("Reliable") as RemoteEvent;
		this.snapshots = folder.WaitForChild("Snapshots") as UnreliableRemoteEvent;
	}

	public connect(
		onSnapshot: (packet: buffer) => void,
		onReliable: (message: ReliableMessage<K>) => void,
	): () => void {
		const snapshotConnection = this.snapshots.OnClientEvent.Connect((packet: unknown) => {
			if (typeIs(packet, "buffer")) {
				onSnapshot(packet);
			}
		});
		const reliableConnection = this.reliable.OnClientEvent.Connect((message: unknown) => {
			onReliable(message as ReliableMessage<K>);
		});
		return () => {
			snapshotConnection.Disconnect();
			reliableConnection.Disconnect();
		};
	}
}

export function bindPlayers<K extends defined>(server: ReplicationServer<K, Player>): () => void {
	for (const player of Players.GetPlayers()) {
		server.addPeer(player);
	}
	const added = Players.PlayerAdded.Connect((player) => server.addPeer(player));
	const removing = Players.PlayerRemoving.Connect((player) => server.removePeer(player));
	return () => {
		added.Disconnect();
		removing.Disconnect();
	};
}
