import { ConnectivityService } from "../src/core/connectivity";
import { DatabaseService } from "../src/core/database";
import { MockSyncApiAdapter } from "../src/core/api/SyncApiAdapter";
import { SyncEngine } from "../src/core/sync";
import { CardRangeRepository } from "../src/features/students/CardRangeRepository";

const CENTER_ID = "card-range-sync-center";

describe("center card range refresh", () => {
  const originalAdapter = SyncEngine.getAdapter();
  let adapter: MockSyncApiAdapter;

  beforeEach(() => {
    DatabaseService.init();
    ConnectivityService.setState("online");
    adapter = new MockSyncApiAdapter();
    SyncEngine.setAdapter(adapter);
  });

  afterEach(() => {
    SyncEngine.setAdapter(originalAdapter);
    ConnectivityService.setState("online");
  });

  it("downloads active and inactive ranges for the center and replaces changed or removed values", async () => {
    adapter.setCardRanges([
      {
        id: "range-old",
        center_id: CENTER_ID,
        start_code: "000100",
        end_code: "000199",
        status: "active",
      },
      {
        id: "range-inactive",
        center_id: CENTER_ID,
        start_code: "000200",
        end_code: "000299",
        status: "inactive",
      },
    ]);
    await SyncEngine.refreshCardRanges(CENTER_ID);
    expect(() => CardRangeRepository.assertCodeAllowed(CENTER_ID, "000100")).not.toThrow();
    expect(() => CardRangeRepository.assertCodeAllowed(CENTER_ID, "000200")).toThrow();

    adapter.setCardRanges([{
      id: "range-updated",
      center_id: CENTER_ID,
      start_code: "000300",
      end_code: "000399",
      status: "active",
    }]);
    await SyncEngine.refreshCardRanges(CENTER_ID);

    expect(() => CardRangeRepository.assertCodeAllowed(CENTER_ID, "000100")).toThrow();
    expect(() => CardRangeRepository.assertCodeAllowed(CENTER_ID, "000300")).not.toThrow();
    expect(DatabaseService.getDb().getAllSync<{ id: string }>(
      "SELECT id FROM card_ranges WHERE center_id = ?",
      [CENTER_ID],
    ).map(({ id }) => id)).toEqual(["range-updated"]);
  });

  it("retains the last trusted range offline without attempting a network refresh", async () => {
    CardRangeRepository.replaceCenterRanges(CENTER_ID, [{
      id: "range-cached",
      center_id: CENTER_ID,
      start_code: "001000",
      end_code: "001099",
      status: "active",
    }]);
    const fetchRanges = jest.spyOn(adapter, "getCardRanges");
    ConnectivityService.setState("offline");

    await SyncEngine.refreshCardRanges(CENTER_ID);

    expect(fetchRanges).not.toHaveBeenCalled();
    expect(() => CardRangeRepository.assertCodeAllowed(CENTER_ID, "001000")).not.toThrow();
  });

  it("rejects a server range belonging to a different center without replacing the trusted cache", async () => {
    CardRangeRepository.replaceCenterRanges(CENTER_ID, [{
      id: "range-safe",
      center_id: CENTER_ID,
      start_code: "005000",
      end_code: "005099",
      status: "active",
    }]);
    adapter.setCardRanges([{
      id: "foreign-range",
      center_id: "another-center",
      start_code: "009000",
      end_code: "009099",
      status: "active",
    }]);

    await expect(SyncEngine.refreshCardRanges(CENTER_ID)).rejects.toThrow(
      "تعذر تحميل نطاق البطاقات الموثوق",
    );
    expect(() => CardRangeRepository.assertCodeAllowed(CENTER_ID, "005000")).not.toThrow();
    expect(DatabaseService.getDb().getAllSync<{ id: string }>(
      "SELECT id FROM card_ranges WHERE center_id = ?",
      [CENTER_ID],
    ).map(({ id }) => id)).toEqual(["range-safe"]);
  });
});
