import json
import csv
from transformers import pipeline

print("Loading MeridianPII model...")

pipe = pipeline(
    "token-classification",
    model="plingampally/meridianpii-hi-v2",
    aggregation_strategy="simple"
)

THRESHOLD = 0.15

print(f"Model loaded successfully!")
print(f"Confidence threshold: {THRESHOLD}\n")

with open("test_cases.json", "r", encoding="utf-8") as f:
    test_cases = json.load(f)

rows = []

for test in test_cases:
    print("=" * 70)
    print(f"Test ID   : {test['id']}")
    print(f"Category  : {test['category']}")
    print(f"Type      : {test['type']}")
    print(f"Input     : {test['text']}")

    results = pipe(test["text"])

    detected_count = 0

    for entity in results:
        score = float(entity["score"])

        # Apply the 0.15 confidence threshold
        if score >= THRESHOLD:
            detected_count += 1

            detected_text = entity["word"]
            detected_label = entity["entity_group"]

            print(f"  Detected : {detected_text}")
            print(f"  Label    : {detected_label}")
            print(f"  Score    : {score:.4f}")

            rows.append({
                "id": test["id"],
                "category": test["category"],
                "type": test["type"],
                "language": test["language"],
                "input": test["text"],
                "detected_text": detected_text,
                "detected_label": detected_label,
                "confidence": f"{score:.4f}",
                "threshold": THRESHOLD
            })

    if detected_count == 0:
        print("  Detected : NONE")

        rows.append({
            "id": test["id"],
            "category": test["category"],
            "type": test["type"],
            "language": test["language"],
            "input": test["text"],
            "detected_text": "",
            "detected_label": "NONE",
            "confidence": "",
            "threshold": THRESHOLD
        })

print("\nSaving predictions...")

with open(
    "raw_predictions.csv",
    "w",
    newline="",
    encoding="utf-8-sig"
) as f:

    fieldnames = [
        "id",
        "category",
        "type",
        "language",
        "input",
        "detected_text",
        "detected_label",
        "confidence",
        "threshold"
    ]

    writer = csv.DictWriter(f, fieldnames=fieldnames)
    writer.writeheader()
    writer.writerows(rows)

print("Saved: raw_predictions.csv")
print("\nValidation run completed.")