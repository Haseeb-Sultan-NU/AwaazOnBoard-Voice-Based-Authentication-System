from src.database import engine
from src.models import Base

print("🧨 Nuking old database tables...")
Base.metadata.drop_all(bind=engine)

print("🏗️ Rebuilding fresh tables with CNIC schema...")
Base.metadata.create_all(bind=engine)

print("✅ Database is perfectly clean and ready!")