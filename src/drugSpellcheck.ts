// Common psychiatric medications for fuzzy spell-correction before MOA lookup.
const PSYCH_DRUGS: readonly string[] = [
  "fluoxetine", "sertraline", "paroxetine", "citalopram", "escitalopram", "fluvoxamine",
  "venlafaxine", "duloxetine", "desvenlafaxine", "levomilnacipran", "milnacipran",
  "bupropion", "mirtazapine", "trazodone", "nefazodone", "vilazodone", "vortioxetine",
  "amitriptyline", "nortriptyline", "imipramine", "clomipramine", "doxepin", "desipramine",
  "trimipramine", "protriptyline", "maprotiline",
  "phenelzine", "tranylcypromine", "isocarboxazid", "selegiline", "rasagiline",
  "lithium", "valproate", "valproic acid", "divalproex", "carbamazepine", "oxcarbazepine",
  "lamotrigine", "topiramate", "gabapentin", "pregabalin", "levetiracetam",
  "haloperidol", "risperidone", "olanzapine", "quetiapine", "clozapine", "aripiprazole",
  "ziprasidone", "lurasidone", "paliperidone", "asenapine", "iloperidone", "cariprazine",
  "brexpiprazole", "lumateperone", "chlorpromazine", "fluphenazine", "perphenazine",
  "thioridazine", "trifluoperazine", "amisulpride", "sulpiride", "pimozide",
  "lorazepam", "diazepam", "clonazepam", "alprazolam", "oxazepam", "temazepam",
  "chlordiazepoxide", "midazolam", "zolpidem", "zaleplon", "eszopiclone",
  "methylphenidate", "dexmethylphenidate", "lisdexamfetamine", "amphetamine", "atomoxetine",
  "guanfacine", "clonidine", "modafinil", "armodafinil",
  "buspirone", "hydroxyzine", "propranolol", "prazosin", "clonidine",
  "donepezil", "rivastigmine", "galantamine", "memantine",
  "methadone", "buprenorphine", "naltrexone", "acamprosate", "disulfiram",
  "tramadol", "tapentadol", "codeine", "morphine", "oxycodone",
  "quetiapine xr", "seroquel", "abilify", "depakote", "lamictal", "tegretol",
  "prozac", "zoloft", "lexapro", "paxil", "celexa", "effexor", "cymbalta", "wellbutrin",
  "zyprexa", "risperdal", "haldol", "geodon", "latuda", "remeron", "trazodone",
];

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const row = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = tmp;
    }
  }
  return row[n];
}

function normalizeInput(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, " ");
}

function titleCaseDrug(name: string): string {
  return name.replace(/\b\w/g, c => c.toUpperCase());
}

/** Fuzzy-match a drug name to the nearest known psychiatric medication. */
export function correctDrugName(input: string): { corrected: string; wasCorrected: boolean } {
  const raw = input.trim();
  if (!raw) return { corrected: raw, wasCorrected: false };

  const lower = normalizeInput(raw);
  if (PSYCH_DRUGS.includes(lower)) return { corrected: raw, wasCorrected: false };

  let best = lower;
  let bestDist = Infinity;
  for (const drug of PSYCH_DRUGS) {
    const d = levenshtein(lower, drug);
    if (d < bestDist) {
      bestDist = d;
      best = drug;
    }
  }

  const maxLen = Math.max(lower.length, best.length);
  const threshold = maxLen <= 4 ? 1 : maxLen <= 7 ? 2 : 3;
  if (bestDist > 0 && bestDist <= threshold) {
    return { corrected: titleCaseDrug(best), wasCorrected: true };
  }

  return { corrected: raw, wasCorrected: false };
}
