import json
from transformers import pipeline

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

passed = 0
failed = 0

print("=" * 70)
print("              MERIDIANPII TEST RESULTS")
print("=" * 70)

for test in test_cases:

    results = pipe(test["text"])

    # Get entity types detected by model
    detected = set()

    for entity in results:
        detected.add(entity["entity_group"])

    expected = set(test["expected"])

    # Check whether expected entities were detected
    if expected.issubset(detected):
        status = "PASS"
        passed += 1
    else:
        status = "FAIL"
        failed += 1

    print(f"\n{test['id']} | {test['language']} | {status}")
    print(f"Input    : {test['text']}")
    print(f"Expected : {', '.join(expected) if expected else 'NONE'}")
    print(f"Detected : {', '.join(detected) if detected else 'NONE'}")

print("\n" + "=" * 70)
print("                    TEST SUMMARY")
print("=" * 70)

total = len(test_cases)
accuracy = (passed / total) * 100 if total > 0 else 0

print(f"Total tests : {total}")
print(f"Passed      : {passed}")
print(f"Failed      : {failed}")
print(f"Accuracy    : {accuracy:.2f}%")

print("=" * 70)