-- Run only against a test database after all three recommendation job migrations.
BEGIN;
SET LOCAL plpgsql.check_asserts = on;
SET LOCAL ROLE service_role;

DO $$
DECLARE
  first_id uuid;
  second_id uuid;
  legacy_id uuid;
  claimed public.recommendation_jobs%ROWTYPE;
  matches integer;
BEGIN
  INSERT INTO public.recommendation_jobs (query, access_token_hash)
  VALUES ('Access fixture A', repeat('a', 64)) RETURNING id INTO first_id;
  INSERT INTO public.recommendation_jobs (query, access_token_hash)
  VALUES ('Access fixture B', repeat('b', 64)) RETURNING id INTO second_id;
  INSERT INTO public.recommendation_jobs (query)
  VALUES ('Legacy fixture') RETURNING id INTO legacy_id;

  SELECT count(*) INTO matches FROM public.recommendation_jobs
    WHERE id = first_id AND access_token_hash = repeat('a', 64);
  ASSERT matches = 1, 'Matching ID and digest must allow a read';
  SELECT count(*) INTO matches FROM public.recommendation_jobs
    WHERE id = second_id AND access_token_hash = repeat('a', 64);
  ASSERT matches = 0, 'A different job must reject the digest';
  SELECT count(*) INTO matches FROM public.recommendation_jobs
    WHERE id = legacy_id AND access_token_hash = repeat('a', 64);
  ASSERT matches = 0, 'Legacy rows without tokens must remain inaccessible';

  BEGIN
    INSERT INTO public.recommendation_jobs (query, access_token_hash)
      VALUES ('Invalid digest', 'raw-token');
    RAISE EXCEPTION 'Malformed digests must not be accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  SELECT * INTO claimed FROM public.claim_recommendation_job(first_id);
  ASSERT claimed.status = 'processing', 'Adding a column must preserve claim RPC';
  ASSERT claimed.access_token_hash = repeat('a', 64), 'Claim must preserve credential digest';
  SELECT * INTO claimed FROM public.finish_recommendation_job(
    first_id, claimed.lock_token, 'completed', '{"movies":[],"series":[]}'::jsonb, NULL
  );
  ASSERT claimed.status = 'completed', 'Completion RPC must keep working';
  ASSERT claimed.access_token_hash = repeat('a', 64), 'Completion must preserve digest';
END;
$$;
ROLLBACK;
