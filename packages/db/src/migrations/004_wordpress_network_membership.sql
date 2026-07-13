CREATE TABLE public.wordpress_network_servers (
    network_id uuid NOT NULL,
    server_id uuid NOT NULL,
    network_server_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT wordpress_network_servers_pkey PRIMARY KEY (network_id, server_id),
    CONSTRAINT wordpress_network_servers_number_key UNIQUE (network_id, network_server_id),
    CONSTRAINT wordpress_network_servers_number_check CHECK (network_server_id > 0),
    CONSTRAINT wordpress_network_servers_network_id_fkey FOREIGN KEY (network_id) REFERENCES public.wordpress_networks(id) ON DELETE CASCADE,
    CONSTRAINT wordpress_network_servers_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE CASCADE
);


INSERT INTO public.wordpress_network_servers (network_id, server_id, network_server_id)
SELECT id, primary_server_id, 1
FROM public.wordpress_networks
WHERE primary_server_id IS NOT NULL
ON CONFLICT DO NOTHING;


CREATE INDEX wordpress_network_servers_server_idx ON public.wordpress_network_servers USING btree (server_id);
