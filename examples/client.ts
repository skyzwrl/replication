import { ReplicatedStorage, Workspace } from "@rbxts/services";
import { RemoteClientTransport, ReplicationClient } from "@skyzwrl/replication";

const models = ReplicatedStorage.WaitForChild("ReplicatedModels");
const container = new Instance("Folder");
container.Name = "Replicated";
container.Parent = Workspace;

const client = new ReplicationClient<string, Model>({
	transport: new RemoteClientTransport(),
	spawn: (key, data, cframe) => {
		const model = models.WaitForChild(data as string).Clone() as Model;
		model.Name = key;
		model.PivotTo(cframe);
		model.Parent = container;
		return model;
	},
	despawn: (model) => model.Destroy(),
});

client.start();

// lag compensated hits should be checked against what the player was actually looking at
export function shotTimestamp(): number {
	return client.getRenderTime();
}
