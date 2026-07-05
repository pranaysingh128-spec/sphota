export interface DrugInteraction {
  severity: "danger" | "warning";
  label: string;
  detail: string;
  drugs: [string, string];
}

interface Rule {
  group1: RegExp[];
  group2: RegExp[];
  severity: "danger" | "warning";
  label: string;
  detail: string;
}

const RULES: Rule[] = [
  {
    group1: [/\bmaoi\b|phenelzine|tranylcypromine|isocarboxazid|selegiline/],
    group2: [/\bssri\b|fluoxetine|sertraline|paroxetine|citalopram|escitalopram|fluvoxamine/],
    severity: "danger",
    label: "MAOI + SSRI",
    detail: "High risk of serotonin syndrome — potentially life-threatening."
  },
  {
    group1: [/\bmaoi\b|phenelzine|tranylcypromine|isocarboxazid|selegiline/],
    group2: [/\bsnri\b|venlafaxine|duloxetine|desvenlafaxine|levomilnacipran/],
    severity: "danger",
    label: "MAOI + SNRI",
    detail: "High risk of serotonin syndrome — potentially life-threatening."
  },
  {
    group1: [/\bmaoi\b|phenelzine|tranylcypromine|isocarboxazid|selegiline/],
    group2: [/tramadol|meperidine|pethidine/],
    severity: "danger",
    label: "MAOI + Opioid",
    detail: "Severe serotonin syndrome or hypertensive crisis risk."
  },
  {
    group1: [/\bmaoi\b|phenelzine|tranylcypromine|isocarboxazid|selegiline/],
    group2: [/bupropion/],
    severity: "danger",
    label: "MAOI + Bupropion",
    detail: "Risk of hypertensive crisis and seizures."
  },
  {
    group1: [/clozapine/],
    group2: [/benzodiazepine|diazepam|lorazepam|clonazepam|alprazolam|temazepam|oxazepam/],
    severity: "danger",
    label: "Clozapine + Benzodiazepine",
    detail: "Risk of respiratory depression, cardiovascular collapse."
  },
  {
    group1: [/lithium/],
    group2: [/nsaid|ibuprofen|naproxen|indomethacin|diclofenac|celecoxib/],
    severity: "warning",
    label: "Lithium + NSAID",
    detail: "NSAIDs can raise lithium levels, increasing toxicity risk."
  },
  {
    group1: [/lithium/],
    group2: [/ace inhibitor|lisinopril|enalapril|ramipril|captopril|perindopril/],
    severity: "warning",
    label: "Lithium + ACE Inhibitor",
    detail: "ACE inhibitors can elevate lithium levels significantly."
  },
  {
    group1: [/lithium/],
    group2: [/thiazide|hydrochlorothiazide|chlorothiazide|bendroflumethiazide/],
    severity: "warning",
    label: "Lithium + Thiazide",
    detail: "Thiazide diuretics reduce lithium excretion, raising toxicity risk."
  },
  {
    group1: [/valproate|valproic acid|divalproex|depakote/],
    group2: [/lamotrigine|lamictal/],
    severity: "warning",
    label: "Valproate + Lamotrigine",
    detail: "Valproate doubles lamotrigine levels — increases toxicity risk and requires dose adjustment."
  },
  {
    group1: [/carbamazepine|tegretol/],
    group2: [/haloperidol|haldol/],
    severity: "warning",
    label: "Carbamazepine + Haloperidol",
    detail: "Risk of neurotoxicity; carbamazepine lowers haloperidol levels."
  },
  {
    group1: [/fluoxetine|paroxetine/],
    group2: [/aripiprazole|abilify/],
    severity: "warning",
    label: "CYP2D6 Inhibitor + Aripiprazole",
    detail: "Fluoxetine/paroxetine inhibit CYP2D6, raising aripiprazole levels. Dose reduction may be needed."
  },
  {
    group1: [/fluoxetine|paroxetine/],
    group2: [/risperidone/],
    severity: "warning",
    label: "CYP2D6 Inhibitor + Risperidone",
    detail: "Increases risperidone plasma levels — monitor for side effects."
  },
  {
    group1: [/tramadol/],
    group2: [/\bssri\b|fluoxetine|sertraline|paroxetine|citalopram|escitalopram/],
    severity: "warning",
    label: "Tramadol + SSRI",
    detail: "Increased serotonin syndrome risk; also lowers seizure threshold."
  },
  {
    group1: [/methadone/],
    group2: [/quetiapine|seroquel|ziprasidone|geodon|haloperidol|thioridazine|chlorpromazine/],
    severity: "warning",
    label: "Methadone + QT-prolonging Agent",
    detail: "Both prolong QT interval — combined use increases risk of torsades de pointes."
  },
  {
    group1: [/quetiapine|seroquel/],
    group2: [/lorazepam|ativan/],
    severity: "warning",
    label: "Quetiapine + Lorazepam (IV)",
    detail: "IV lorazepam + quetiapine associated with rare but serious cardiovascular events."
  },
  {
    group1: [/clozapine/],
    group2: [/carbamazepine|tegretol/],
    severity: "danger",
    label: "Clozapine + Carbamazepine",
    detail: "Both are bone marrow suppressants — concurrent use significantly increases agranulocytosis risk."
  },
  {
    group1: [/clozapine/],
    group2: [/ciprofloxacin|fluvoxamine|erythromycin/],
    severity: "warning",
    label: "Clozapine + CYP1A2 Inhibitor",
    detail: "Inhibitors of CYP1A2 raise clozapine levels — risk of toxicity."
  },
  {
    group1: [/antipsychotic|haloperidol|risperidone|olanzapine|quetiapine|clozapine|aripiprazole|lurasidone|ziprasidone|amisulpride/],
    group2: [/anticholinergic|benztropine|trihexyphenidyl|biperiden|procyclidine/],
    severity: "warning",
    label: "Antipsychotic + Anticholinergic",
    detail: "Additive anticholinergic burden — risk of delirium, urinary retention, constipation."
  },
  {
    group1: [/\bssri\b|fluoxetine|sertraline|paroxetine|citalopram|escitalopram|fluvoxamine/],
    group2: [/triptan|sumatriptan|rizatriptan|zolmitriptan|naratriptan|eletriptan|almotriptan|frovatriptan/],
    severity: "danger",
    label: "SSRI + Triptan",
    detail: "Serotonin syndrome risk."
  },
  {
    group1: [/antipsychotic|haloperidol|risperidone|olanzapine|quetiapine|clozapine|aripiprazole|lurasidone|ziprasidone|amisulpride|chlorpromazine|abilify/],
    group2: [/metoclopramide|reglan/],
    severity: "danger",
    label: "Antipsychotic + Metoclopramide",
    detail: "Extrapyramidal risk — both block dopamine receptors, compounding movement disorder risk."
  },
  {
    group1: [/\btca\b|tricyclic|amitriptyline|nortriptyline|imipramine|clomipramine|doxepin|desipramine|trimipramine/],
    group2: [/\bmaoi\b|phenelzine|tranylcypromine|isocarboxazid|selegiline/],
    severity: "danger",
    label: "TCA + MAOI",
    detail: "Serotonin syndrome risk — potentially life-threatening combination."
  },
  {
    group1: [/warfarin|coumadin/],
    group2: [/\bssri\b|fluoxetine|sertraline|paroxetine|citalopram|escitalopram|fluvoxamine/],
    severity: "danger",
    label: "Warfarin + SSRI",
    detail: "Bleeding risk — SSRIs inhibit platelet aggregation and may elevate INR."
  },
];

function matchesGroup(drugName: string, patterns: RegExp[]): boolean {
  const n = drugName.toLowerCase();
  return patterns.some(re => re.test(n));
}

export function checkInteractions(activeMedNames: string[]): DrugInteraction[] {
  const found: DrugInteraction[] = [];
  if (activeMedNames.length < 2) return found;

  for (const rule of RULES) {
    for (let i = 0; i < activeMedNames.length; i++) {
      for (let j = i + 1; j < activeMedNames.length; j++) {
        const a = activeMedNames[i];
        const b = activeMedNames[j];
        const match =
          (matchesGroup(a, rule.group1) && matchesGroup(b, rule.group2)) ||
          (matchesGroup(b, rule.group1) && matchesGroup(a, rule.group2));
        if (match) {
          const key = rule.label;
          if (!found.some(f => f.label === key)) {
            found.push({ severity: rule.severity, label: rule.label, detail: rule.detail, drugs: [a, b] });
          }
        }
      }
    }
  }

  return found;
}

export function checkAllergyConflict(activeMedNames: string[], allergies: string[]): string[] {
  const conflicts: string[] = [];
  for (const med of activeMedNames) {
    const m = med.toLowerCase();
    for (const allergy of allergies) {
      const a = allergy.toLowerCase().trim();
      if (a.length > 2 && (m.includes(a) || a.includes(m))) {
        conflicts.push(`${med} conflicts with allergy: ${allergy}`);
      }
    }
  }
  return conflicts;
}
