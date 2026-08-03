export {
	FakeAgentHostAdapter,
	type FakeAdapterCounters,
	type FakeTurnOutcome,
	type FakeTurnProgress,
} from "./fake-adapter.js";
export {
	type FixedCommand,
	type FrozenRepositoryDefinition,
	type MaterializedFrozenRepository,
	materializeFrozenRepository,
	runFixedCommand,
} from "./frozen-repository.js";
export {
	type FixtureHostTurnTrace,
	type FixtureReplayMode,
	type FixtureVerificationCommand,
	type MissionFixtureEnvironment,
	type MissionFixtureRunResult,
	type ScriptedContractAcknowledgement,
	type ScriptedMissionFixture,
	type ScriptedMissionTurn,
	runMissionFixture,
} from "./mission-fixture-runner.js";
export {
	type BackendAndroidFixtureEnvironment,
	backendAndroidContracts,
	backendAndroidCoordinatorConfig,
	backendAndroidFixtureRoot,
	backendAndroidIds,
	backendAndroidMissionContext,
	backendAndroidMissionFixture,
	backendAndroidRepositories,
} from "./fixtures/backend-android.js";
