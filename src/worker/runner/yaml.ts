// A tiny YAML writer for the generated Compose override (D-059). JSON can't
// express Compose's `!reset` and `!override` tags, so this writes block YAML
// with every scalar as a JSON string, which YAML reads unchanged.

export interface Tagged {
  tag: "!reset" | "!override";
  value: YamlValue;
}

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue } | Tagged;

export const reset = (value: YamlValue): Tagged => ({ tag: "!reset", value });
export const override = (value: YamlValue): Tagged => ({ tag: "!override", value });

export const isTagged = (v: YamlValue): v is Tagged => typeof v === "object" && v !== null && !Array.isArray(v) && "tag" in v && "value" in v;

function scalar(v: string | number | boolean | null): string {
  return v === null ? "null" : typeof v === "string" ? JSON.stringify(v) : String(v);
}

function emptyOrScalar(v: YamlValue): string | undefined {
  if (v === null || typeof v !== "object") return scalar(v);
  if (Array.isArray(v) && v.length === 0) return "[]";
  if (!Array.isArray(v) && !isTagged(v) && Object.keys(v).length === 0) return "{}";
  return undefined;
}

function lines(value: YamlValue, indent: string): string[] {
  const out: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      const inline = emptyOrScalar(item);
      if (inline !== undefined) out.push(`${indent}- ${inline}`);
      else {
        const nested = lines(item, `${indent}  `);
        out.push(`${indent}- ${(nested[0] ?? "").trimStart()}`, ...nested.slice(1));
      }
    }
    return out;
  }
  for (const [key, raw] of Object.entries(value as Record<string, YamlValue>)) {
    const tag = isTagged(raw) ? `${raw.tag} ` : "";
    const v = isTagged(raw) ? raw.value : raw;
    const inline = emptyOrScalar(v);
    if (inline !== undefined) out.push(`${indent}${JSON.stringify(key)}: ${tag}${inline}`);
    else out.push(`${indent}${JSON.stringify(key)}:${tag ? ` ${tag.trim()}` : ""}`, ...lines(v, `${indent}  `));
  }
  return out;
}

export function toYaml(value: { [key: string]: YamlValue }): string {
  return `${lines(value, "").join("\n")}\n`;
}
