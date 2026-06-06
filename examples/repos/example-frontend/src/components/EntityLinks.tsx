type Entity = {
  id: string;
  name: string;
};

export const EntityLinks = ({ entity, navigate }: { entity: Entity; navigate: (path: string) => void }) => {
  const openDetail = () => {
    navigate(`/entities/${entity.id}/detail`);
  };

  return (
    <button type="button" onClick={openDetail}>
      Open {entity.name}
    </button>
  );
};
