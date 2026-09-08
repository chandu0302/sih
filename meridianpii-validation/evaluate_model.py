import json
import csv

THRESHOLD = 0.15

def normalize(text):
    return " ".join(text.strip().lower().split())


# Load test cases
with open("test_cases.json", "r", encoding="utf-8") as f:
    test_cases = json.load(f)


# Load model predictions
predictions = {}

with open("raw_predictions.csv", "r", encoding="utf-8-sig") as f:
    reader = csv.DictReader(f)

    for row in reader:
        test_id = row["id"]

        if test_id not in predictions:
            predictions[test_id] = []

        if row["detected_label"] != "NONE":
            predictions[test_id].append({
                "text": row["detected_text"],
                "label": row["detected_label"],
                "confidence": float(row["confidence"])
            })


TP = 0
FP = 0
FN = 0

evaluation_rows = []


for test in test_cases:

    test_id = test["id"]
    # Structured PII is evaluated separately.
    # Do not include it in NER precision/recall/F1.
    if test["category"] == "structured":
        continue

    expected = [
        {
            "text": normalize(item["text"]),
            "label": item["label"]
        }
        for item in test["expected"]
    ]

    detected = [
        {
            "text": normalize(item["text"]),
            "label": item["label"],
            "confidence": item["confidence"]
        }
        for item in predictions.get(test_id, [])
    ]

    matched_expected = set()
    matched_detected = set()

    # Exact text + exact label matching
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

                evaluation_rows.append({
                    "id": test_id,
                    "category": test["category"],
                    "result": "TP",
                    "expected_text": e["text"],
                    "expected_label": e["label"],
                    "detected_text": d["text"],
                    "detected_label": d["label"],
                    "confidence": d["confidence"]
                })

                break

    # False positives
    for d_index, d in enumerate(detected):

        if d_index not in matched_detected:

            FP += 1

            evaluation_rows.append({
                "id": test_id,
                "category": test["category"],
                "result": "FP",
                "expected_text": "",
                "expected_label": "",
                "detected_text": d["text"],
                "detected_label": d["label"],
                "confidence": d["confidence"]
            })

    # False negatives
    for e_index, e in enumerate(expected):

        if e_index not in matched_expected:

            FN += 1

            evaluation_rows.append({
                "id": test_id,
                "category": test["category"],
                "result": "FN",
                "expected_text": e["text"],
                "expected_label": e["label"],
                "detected_text": "",
                "detected_label": "",
                "confidence": ""
            })


# Calculate metrics

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


print("\n" + "=" * 60)
print("MeridianPII Evaluation")
print("=" * 60)

print(f"Threshold : {THRESHOLD}")
print(f"TP        : {TP}")
print(f"FP        : {FP}")
print(f"FN        : {FN}")

print(f"\nPrecision : {precision:.4f} ({precision * 100:.2f}%)")
print(f"Recall    : {recall:.4f} ({recall * 100:.2f}%)")
print(f"F1 Score  : {f1:.4f} ({f1 * 100:.2f}%)")


# Save detailed evaluation results

with open(
    "evaluation_results.csv",
    "w",
    newline="",
    encoding="utf-8-sig"
) as f:

    fieldnames = [
        "id",
        "category",
        "result",
        "expected_text",
        "expected_label",
        "detected_text",
        "detected_label",
        "confidence"
    ]

    writer = csv.DictWriter(f, fieldnames=fieldnames)
    writer.writeheader()
    writer.writerows(evaluation_rows)


# Save summary

summary = {
    "threshold": THRESHOLD,
    "true_positive": TP,
    "false_positive": FP,
    "false_negative": FN,
    "precision": precision,
    "recall": recall,
    "f1": f1
}

with open(
    "evaluation_summary.json",
    "w",
    encoding="utf-8"
) as f:

    json.dump(summary, f, indent=4)


print("\nSaved:")
print("  evaluation_results.csv")
print("  evaluation_summary.json")
print("=" * 60)