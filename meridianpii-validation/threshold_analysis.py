import json
import csv
from transformers import pipeline

THRESHOLDS = [0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50]

print("Loading MeridianPII model...")

pipe = pipeline(
    "token-classification",
    model="plingampally/meridianpii-hi-v2",
    aggregation_strategy="simple"
)

print("Model loaded successfully!\n")


# Load test cases
with open("test_cases.json", "r", encoding="utf-8") as f:
    test_cases = json.load(f)


# Only NER cases
ner_cases = [
    test for test in test_cases
    if test["category"] != "structured"
]


# Run model ONCE and keep all predictions.
# This lets us test different thresholds without
# repeatedly loading/running the model.
all_predictions = {}

for test in ner_cases:

    results = pipe(test["text"])

    predictions = []

    for entity in results:

        predictions.append({
            "text": " ".join(entity["word"].strip().lower().split()),
            "label": entity["entity_group"],
            "confidence": float(entity["score"])
        })

    all_predictions[test["id"]] = predictions


def normalize(text):
    return " ".join(text.strip().lower().split())


results_table = []


for threshold in THRESHOLDS:

    TP = 0
    FP = 0
    FN = 0

    for test in ner_cases:

        expected = [
            {
                "text": normalize(item["text"]),
                "label": item["label"]
            }
            for item in test["expected"]
        ]

        detected = [
            item
            for item in all_predictions[test["id"]]
            if item["confidence"] >= threshold
        ]

        matched_expected = set()
        matched_detected = set()

        # Match exact text + exact label
        for d_index, d in enumerate(detected):

            for e_index, e in enumerate(expected):

                if e_index in matched_expected:
                    continue

                if (
                    d["text"] == e["text"]
                    and d["label"] == e["label"]
                ):
                    TP += 1
                    matched_expected.add(e_index)
                    matched_detected.add(d_index)
                    break

        # Remaining detections = FP
        FP += len(detected) - len(matched_detected)

        # Remaining expected = FN
        FN += len(expected) - len(matched_expected)


    if TP + FP > 0:
        precision = TP / (TP + FP)
    else:
        precision = 0

    if TP + FN > 0:
        recall = TP / (TP + FN)
    else:
        recall = 0

    if precision + recall > 0:
        f1 = 2 * precision * recall / (precision + recall)
    else:
        f1 = 0


    results_table.append({
        "threshold": threshold,
        "TP": TP,
        "FP": FP,
        "FN": FN,
        "precision": precision,
        "recall": recall,
        "f1": f1
    })


# Print results
print("=" * 75)
print("MERIDIANPII THRESHOLD ANALYSIS")
print("=" * 75)

print(
    f"{'Threshold':<12}"
    f"{'TP':<8}"
    f"{'FP':<8}"
    f"{'FN':<8}"
    f"{'Precision':<14}"
    f"{'Recall':<14}"
    f"{'F1':<14}"
)

print("-" * 75)

for row in results_table:

    print(
        f"{row['threshold']:<12.2f}"
        f"{row['TP']:<8}"
        f"{row['FP']:<8}"
        f"{row['FN']:<8}"
        f"{row['precision'] * 100:<14.2f}"
        f"{row['recall'] * 100:<14.2f}"
        f"{row['f1'] * 100:<14.2f}"
    )


# Find best threshold by F1
best = max(results_table, key=lambda x: x["f1"])

print("\n" + "=" * 75)
print("BEST THRESHOLD BY F1")
print("=" * 75)

print(f"Threshold : {best['threshold']:.2f}")
print(f"Precision : {best['precision'] * 100:.2f}%")
print(f"Recall    : {best['recall'] * 100:.2f}%")
print(f"F1        : {best['f1'] * 100:.2f}%")


# Save CSV
with open(
    "threshold_results.csv",
    "w",
    newline="",
    encoding="utf-8-sig"
) as f:

    fieldnames = [
        "threshold",
        "TP",
        "FP",
        "FN",
        "precision",
        "recall",
        "f1"
    ]

    writer = csv.DictWriter(f, fieldnames=fieldnames)

    writer.writeheader()

    for row in results_table:
        writer.writerow(row)


print("\nSaved: threshold_results.csv")