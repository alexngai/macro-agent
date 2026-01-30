/**
 * Tests for address translation utilities
 */

import { describe, it, expect } from "vitest";
import {
  addressToChannel,
  channelToAddress,
  isLegacyCompatible,
  getLegacyIncompatibilities,
  tryAddressToChannel,
  getAddressMappingTable,
  AddressTranslationError,
  ChannelTranslationError,
  type LegacyChannel,
} from "../utils/address-translation.js";
import type { Address } from "../types.js";

describe("addressToChannel", () => {
  describe("agent addressing", () => {
    it("translates agent address", () => {
      const result = addressToChannel({ agent: "agent-1" });
      expect(result).toEqual({
        type: "agent",
        target: "agent-1",
      });
    });
  });

  describe("task addressing", () => {
    it("translates task address", () => {
      const result = addressToChannel({ task: "task-123" });
      expect(result).toEqual({
        type: "task",
        target: "task-123",
      });
    });
  });

  describe("scope addressing", () => {
    it("translates scope address to topic channel", () => {
      const result = addressToChannel({ scope: "my-scope" });
      expect(result).toEqual({
        type: "topic",
        target: "my-scope",
      });
    });
  });

  describe("role addressing", () => {
    it("translates simple role address", () => {
      const result = addressToChannel({ role: "worker" });
      expect(result).toEqual({
        type: "role",
        target: "worker",
        role: "worker",
        coordinatorId: undefined,
      });
    });

    it("translates role address with scope", () => {
      const result = addressToChannel({ role: "worker", within: "scope-1" });
      expect(result).toEqual({
        type: "role",
        target: "worker",
        role: "worker",
        coordinatorId: "scope-1",
      });
    });
  });

  describe("broadcast addressing", () => {
    it("translates broadcast address", () => {
      const result = addressToChannel({ broadcast: true });
      expect(result).toEqual({
        type: "broadcast",
        target: "all",
      });
    });
  });

  describe("hierarchical addressing", () => {
    it("translates ancestors address to lineage channel", () => {
      const result = addressToChannel({ ancestors: true });
      expect(result).toEqual({
        type: "lineage",
        target: "ancestors",
      });
    });

    it("translates descendants address to subtree channel", () => {
      const result = addressToChannel({ descendants: true });
      expect(result).toEqual({
        type: "subtree",
        target: "descendants",
      });
    });

    it("throws for parent address", () => {
      expect(() => addressToChannel({ parent: true })).toThrow(
        AddressTranslationError
      );
      expect(() => addressToChannel({ parent: true })).toThrow(
        "Parent addressing not supported"
      );
    });

    it("throws for children address", () => {
      expect(() => addressToChannel({ children: true })).toThrow(
        AddressTranslationError
      );
      expect(() => addressToChannel({ children: true })).toThrow(
        "Children addressing not supported"
      );
    });

    it("throws for siblings address", () => {
      expect(() => addressToChannel({ siblings: true })).toThrow(
        AddressTranslationError
      );
      expect(() => addressToChannel({ siblings: true })).toThrow(
        "Siblings addressing not supported"
      );
    });
  });

  describe("multi-agent addressing", () => {
    it("throws for agents address", () => {
      expect(() => addressToChannel({ agents: ["a", "b"] })).toThrow(
        AddressTranslationError
      );
      expect(() => addressToChannel({ agents: ["a", "b"] })).toThrow(
        "Multi-agent addressing not supported"
      );
    });
  });
});

describe("channelToAddress", () => {
  it("translates agent channel", () => {
    const channel: LegacyChannel = { type: "agent", target: "agent-1" };
    expect(channelToAddress(channel)).toEqual({ agent: "agent-1" });
  });

  it("translates task channel", () => {
    const channel: LegacyChannel = { type: "task", target: "task-123" };
    expect(channelToAddress(channel)).toEqual({ task: "task-123" });
  });

  it("translates topic channel to scope", () => {
    const channel: LegacyChannel = { type: "topic", target: "my-topic" };
    expect(channelToAddress(channel)).toEqual({ scope: "my-topic" });
  });

  it("translates role channel", () => {
    const channel: LegacyChannel = {
      type: "role",
      target: "worker",
      role: "worker",
    };
    expect(channelToAddress(channel)).toEqual({ role: "worker" });
  });

  it("translates role channel with coordinator", () => {
    const channel: LegacyChannel = {
      type: "role",
      target: "worker",
      role: "worker",
      coordinatorId: "coord-1",
    };
    expect(channelToAddress(channel)).toEqual({
      role: "worker",
      within: "coord-1",
    });
  });

  it("translates broadcast channel", () => {
    const channel: LegacyChannel = { type: "broadcast", target: "all" };
    expect(channelToAddress(channel)).toEqual({ broadcast: true });
  });

  it("translates scoped broadcast to role", () => {
    const channel: LegacyChannel = {
      type: "broadcast",
      target: "workers",
      scope: "workers",
    };
    expect(channelToAddress(channel)).toEqual({ role: "worker" });
  });

  it("translates lineage channel to ancestors", () => {
    const channel: LegacyChannel = { type: "lineage", target: "ancestors" };
    expect(channelToAddress(channel)).toEqual({ ancestors: true });
  });

  it("translates subtree channel to descendants", () => {
    const channel: LegacyChannel = { type: "subtree", target: "descendants" };
    expect(channelToAddress(channel)).toEqual({ descendants: true });
  });

  it("throws for unknown channel type", () => {
    const channel = { type: "unknown", target: "x" } as LegacyChannel;
    expect(() => channelToAddress(channel)).toThrow(ChannelTranslationError);
  });
});

describe("round-trip translation", () => {
  const legacyCompatibleAddresses: Address[] = [
    { agent: "agent-1" },
    { task: "task-1" },
    { scope: "scope-1" },
    { role: "worker" },
    { role: "worker", within: "scope-1" },
    { broadcast: true },
    { ancestors: true },
    { descendants: true },
  ];

  it.each(legacyCompatibleAddresses)(
    "address → channel → address: %j",
    (address) => {
      const channel = addressToChannel(address);
      const result = channelToAddress(channel);
      expect(result).toEqual(address);
    }
  );
});

describe("isLegacyCompatible", () => {
  describe("returns true for legacy-compatible addresses", () => {
    it("agent address", () => {
      expect(isLegacyCompatible({ agent: "a" })).toBe(true);
    });

    it("task address", () => {
      expect(isLegacyCompatible({ task: "t" })).toBe(true);
    });

    it("scope address", () => {
      expect(isLegacyCompatible({ scope: "s" })).toBe(true);
    });

    it("role address", () => {
      expect(isLegacyCompatible({ role: "r" })).toBe(true);
    });

    it("broadcast address", () => {
      expect(isLegacyCompatible({ broadcast: true })).toBe(true);
    });

    it("ancestors address", () => {
      expect(isLegacyCompatible({ ancestors: true })).toBe(true);
    });

    it("descendants address", () => {
      expect(isLegacyCompatible({ descendants: true })).toBe(true);
    });
  });

  describe("returns false for new address types", () => {
    it("agents address", () => {
      expect(isLegacyCompatible({ agents: ["a", "b"] })).toBe(false);
    });

    it("parent address", () => {
      expect(isLegacyCompatible({ parent: true })).toBe(false);
    });

    it("children address", () => {
      expect(isLegacyCompatible({ children: true })).toBe(false);
    });

    it("siblings address", () => {
      expect(isLegacyCompatible({ siblings: true })).toBe(false);
    });
  });
});

describe("getLegacyIncompatibilities", () => {
  it("returns empty array for compatible addresses", () => {
    expect(getLegacyIncompatibilities({ agent: "a" })).toEqual([]);
    expect(getLegacyIncompatibilities({ broadcast: true })).toEqual([]);
  });

  it("returns incompatibility for multi-agent", () => {
    expect(getLegacyIncompatibilities({ agents: ["a", "b"] })).toContain(
      "multi-agent addressing"
    );
  });

  it("returns incompatibility for parent", () => {
    expect(getLegacyIncompatibilities({ parent: true })).toContain(
      "parent addressing"
    );
  });

  it("returns incompatibility for children", () => {
    expect(getLegacyIncompatibilities({ children: true })).toContain(
      "children addressing"
    );
  });

  it("returns incompatibility for siblings", () => {
    expect(getLegacyIncompatibilities({ siblings: true })).toContain(
      "siblings addressing"
    );
  });
});

describe("tryAddressToChannel", () => {
  it("returns channel for compatible addresses", () => {
    const result = tryAddressToChannel({ agent: "a" });
    expect(result).toEqual({ type: "agent", target: "a" });
  });

  it("returns undefined for incompatible addresses", () => {
    expect(tryAddressToChannel({ parent: true })).toBeUndefined();
    expect(tryAddressToChannel({ children: true })).toBeUndefined();
    expect(tryAddressToChannel({ siblings: true })).toBeUndefined();
    expect(tryAddressToChannel({ agents: ["a", "b"] })).toBeUndefined();
  });
});

describe("getAddressMappingTable", () => {
  it("returns non-empty mapping table", () => {
    const table = getAddressMappingTable();
    expect(table.length).toBeGreaterThan(0);
  });

  it("includes all address types", () => {
    const table = getAddressMappingTable();
    const mapAddresses = table.map((m) => m.mapAddress);

    expect(mapAddresses).toContain('{ agent: "id" }');
    expect(mapAddresses).toContain('{ task: "id" }');
    expect(mapAddresses).toContain('{ scope: "id" }');
    expect(mapAddresses).toContain('{ role: "worker" }');
    expect(mapAddresses).toContain("{ broadcast: true }");
    expect(mapAddresses).toContain("{ ancestors: true }");
    expect(mapAddresses).toContain("{ descendants: true }");
    expect(mapAddresses).toContain("{ parent: true }");
    expect(mapAddresses).toContain("{ children: true }");
    expect(mapAddresses).toContain("{ siblings: true }");
  });

  it("marks unsupported types with N/A", () => {
    const table = getAddressMappingTable();
    const parentEntry = table.find((m) => m.mapAddress === "{ parent: true }");
    expect(parentEntry?.legacyChannel).toBe("N/A");
    expect(parentEntry?.notes).toBeDefined();
  });
});

describe("Error classes", () => {
  it("AddressTranslationError includes address", () => {
    const error = new AddressTranslationError("test error", { parent: true });
    expect(error.name).toBe("AddressTranslationError");
    expect(error.address).toEqual({ parent: true });
    expect(error.message).toContain("parent");
  });

  it("ChannelTranslationError includes channel", () => {
    const channel: LegacyChannel = { type: "unknown" as any, target: "x" };
    const error = new ChannelTranslationError("test error", channel);
    expect(error.name).toBe("ChannelTranslationError");
    expect(error.channel).toEqual(channel);
  });
});
