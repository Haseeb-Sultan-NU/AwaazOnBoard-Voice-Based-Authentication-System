from datasets import load_dataset

# Load only a small sliver to check
dataset = load_dataset("mozilla-foundation/common_voice_11_0", "ur", split="train", streaming=True)
sample = next(iter(dataset))
print(sample.keys()) 
# Look for 'client_id' - that is your Speaker ID!